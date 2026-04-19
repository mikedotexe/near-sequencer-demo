// Per-recipe audits. Each audit reads a run's raw + onchain.json files and
// produces a lifecycle summary as run-NN.audit.json. The shape differs per
// recipe because each recipe has different observable moments:
//
//   basic   — yielded, resumed, resolved_ok
//   timeout — yielded, resolved_err (after block-scan to find callback)
//   chained — yielded, resumed, dispatched, callback_observed, resolved_ok
//
// All three share: parsed trace events keyed by event name + name, plus
// block-height deltas between observable moments. The aggregate + report
// layers consume these to build the recipe-book artifact.

import { existsSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { ACCOUNTS, ARTIFACTS_DIR, EXPLORER_BASE } from "./config.js";
import {
  blockByHash,
  blockByHeight,
  chunkByHash,
  txStatus,
  type BlockResult,
  type ChunkResult,
  type TxStatusResult,
} from "./rpc.js";
import type { OnchainCapture } from "./capture.js";
import type {
  RawArtifact,
  RawBasicArtifact,
  RawChainedArtifact,
  RawHandoffArtifact,
  RawTimeoutArtifact,
  RecipeName,
} from "./recipes/types.js";

// ---------------------------------------------------------------------------
// Trace-log parsing
// ---------------------------------------------------------------------------
//
// The recipes contract emits each observable as `trace:{JSON}` with
// `{ev, recipe, name, ..., block_ts_ms}`. We filter by `trace:` prefix
// (cheap) and parse the body. The audit matches events by (ev, recipe,
// name) tuple so a single run's events are cleanly distinguishable even
// when the contract is handling multiple runs concurrently.

interface TraceLogBody {
  ev: string;
  recipe: string;
  name: string;
  payload?: string;
  outcome?: string;
  reason?: string;
  target?: string;
  method?: string;
  value?: string;
  // Handoff-specific payload fields (present only on handoff_offered /
  // handoff_released / handoff_refunded variants).
  from?: string;
  to?: string;
  amount?: string;
  refunded_to?: string;
  block_ts_ms: number;
}

function parseTraceLog(log: string): TraceLogBody | null {
  if (!log.startsWith("trace:")) return null;
  try {
    return JSON.parse(log.slice("trace:".length)) as TraceLogBody;
  } catch {
    return null;
  }
}

function findTraceEvents(logs: string[], recipe: RecipeName, name: string): TraceLogBody[] {
  return logs
    .map(parseTraceLog)
    .filter((b): b is TraceLogBody => b !== null && b.recipe === recipe && b.name === name);
}

// ---------------------------------------------------------------------------
// Capture source
// ---------------------------------------------------------------------------
//
// Prefer locally captured data; fall back to live RPC.

interface CaptureSource {
  kind: "onchain_json" | "live_rpc";
  getTxByRole(role: string): TxStatusResult | null;
  getBlockByHash(hash: string): Promise<BlockResult | null>;
  getBlockByHeight(height: number): Promise<BlockResult | null>;
  getChunkByHash(hash: string): Promise<ChunkResult | null>;
}

function buildCaptureSource(raw: RawArtifact, recipeDir: string): CaptureSource {
  // Handoff writes mode-prefixed filenames (e.g. run-claim-01.onchain.json)
  // so claim/timeout runs can share the dir without collisions. Other
  // recipes use plain zero-padded runIndex.
  const suffix =
    raw.recipe === "handoff"
      ? `${raw.mode}-${raw.runIndex.toString().padStart(2, "0")}`
      : raw.runIndex.toString().padStart(2, "0");
  const onchainPath = join(recipeDir, `run-${suffix}.onchain.json`);
  if (existsSync(onchainPath)) {
    const capture = JSON.parse(readFileSync(onchainPath, "utf8")) as OnchainCapture;
    return localSource(capture);
  }
  return liveSource(raw);
}

function localSource(capture: OnchainCapture): CaptureSource {
  const blocksByHash = new Map(Object.entries(capture.blocks));
  const blocksByHeight = new Map<number, BlockResult>();
  for (const b of blocksByHash.values()) blocksByHeight.set(b.header.height, b);
  const chunksByHash = new Map(Object.entries(capture.chunks));
  return {
    kind: "onchain_json",
    getTxByRole(role) {
      return capture.txStatus[role] ?? null;
    },
    async getBlockByHash(hash) {
      const cached = blocksByHash.get(hash);
      if (cached) return cached;
      try {
        const fetched = await blockByHash(hash);
        blocksByHash.set(hash, fetched);
        blocksByHeight.set(fetched.header.height, fetched);
        return fetched;
      } catch {
        return null;
      }
    },
    async getBlockByHeight(height) {
      const cached = blocksByHeight.get(height);
      if (cached) return cached;
      try {
        const fetched = await blockByHeight(height);
        blocksByHeight.set(height, fetched);
        blocksByHash.set(fetched.header.hash, fetched);
        return fetched;
      } catch {
        return null;
      }
    },
    async getChunkByHash(hash) {
      const cached = chunksByHash.get(hash);
      if (cached) return cached;
      try {
        const fetched = await chunkByHash(hash);
        chunksByHash.set(hash, fetched);
        return fetched;
      } catch {
        return null;
      }
    },
  };
}

function liveSource(raw: RawArtifact): CaptureSource {
  const txCache: Record<string, TxStatusResult | null> = {};
  // Pre-populate role -> tx hash mapping from the raw artifact.
  const roleToHash: Record<string, string> = {};
  if (raw.recipe === "basic") {
    roleToHash.yield = raw.yieldTxHash;
    roleToHash.resume = raw.resumeTxHash;
  } else if (raw.recipe === "timeout") {
    roleToHash.yield = raw.yieldTxHash;
  } else if (raw.recipe === "chained") {
    roleToHash.yield = raw.yieldTxHash;
    roleToHash.resume = raw.resumeTxHash;
  } else {
    // handoff: resumeTxHash is null in timeout mode.
    roleToHash.yield = raw.yieldTxHash;
    if (raw.resumeTxHash) roleToHash.resume = raw.resumeTxHash;
  }

  const blocksByHash = new Map<string, BlockResult>();
  const blocksByHeight = new Map<number, BlockResult>();
  const chunksByHash = new Map<string, ChunkResult>();
  return {
    kind: "live_rpc",
    getTxByRole(role) {
      // Synchronous accessor; live-RPC source fetches lazily on first
      // invocation by tracking a per-role cache keyed on hash.
      if (role in txCache) return txCache[role] ?? null;
      const hash = roleToHash[role];
      if (!hash) return null;
      // Kick off an async fetch and cache via promise — but the sync
      // shape forces us to return null this call. Next time the role
      // is requested the cached value is present. For a single audit
      // run this means live-RPC callers must invoke getTxByRole twice
      // (first to trigger fetch, second to observe). Simple, but if
      // live-RPC auditing becomes common refactor this to Promise<T>.
      txStatus(hash, raw.signer)
        .then((t) => {
          txCache[role] = t;
        })
        .catch(() => {
          txCache[role] = null;
        });
      return null;
    },
    async getBlockByHash(hash) {
      const cached = blocksByHash.get(hash);
      if (cached) return cached;
      try {
        const fetched = await blockByHash(hash);
        blocksByHash.set(hash, fetched);
        blocksByHeight.set(fetched.header.height, fetched);
        return fetched;
      } catch {
        return null;
      }
    },
    async getBlockByHeight(height) {
      const cached = blocksByHeight.get(height);
      if (cached) return cached;
      try {
        const fetched = await blockByHeight(height);
        blocksByHeight.set(height, fetched);
        blocksByHash.set(fetched.header.hash, fetched);
        return fetched;
      } catch {
        return null;
      }
    },
    async getChunkByHash(hash) {
      const cached = chunksByHash.get(hash);
      if (cached) return cached;
      try {
        const fetched = await chunkByHash(hash);
        chunksByHash.set(hash, fetched);
        return fetched;
      } catch {
        return null;
      }
    },
  };
}

// ---------------------------------------------------------------------------
// DAG-placement invariant
// ---------------------------------------------------------------------------
//
// NEP-519 semantics: `Promise::new_yield` schedules the callback receipt at
// yield time. `yield_id.resume(payload)` delivers a payload to that
// already-scheduled receipt; it does NOT create a new one. The 200-block
// timeout path is the same — the runtime delivers `PromiseError` to the
// existing receipt. Consequence: all trace events emitted by callback code
// (`recipe_resolved_*`, `recipe_dispatched`, `recipe_callback_observed`)
// land in the YIELD tx's `receipts_outcome[]`, not the resume tx's.
//
// The resume tx's DAG contains only `recipe_resumed` (emitted by the
// resume method itself, which is an ordinary FunctionCall).
//
// This invariant is a spec-level claim. If a future near-sdk bump ever
// changes where these receipts live, the check here fires loudly rather
// than letting the audit quietly produce misleading reports.

export type TxRole = "yield" | "resume";

export interface DagInvariantViolation {
  event: string;
  expected: TxRole;
  actual: TxRole | null;
}

function expectedDagPlacement(
  recipe: RecipeName,
  opts?: { handoffMode?: "claim" | "timeout" },
): Record<string, TxRole> {
  if (recipe === "basic") {
    return {
      recipe_yielded: "yield",
      recipe_resumed: "resume",
      recipe_resolved_ok: "yield",
    };
  }
  if (recipe === "timeout") {
    return {
      recipe_yielded: "yield",
      recipe_resolved_err: "yield",
    };
  }
  if (recipe === "chained") {
    return {
      recipe_yielded: "yield",
      recipe_resumed: "resume",
      recipe_dispatched: "yield",
      recipe_callback_observed: "yield",
      recipe_resolved_ok: "yield",
    };
  }
  // handoff
  if (opts?.handoffMode === "timeout") {
    return {
      recipe_yielded: "yield",
      recipe_resolved_err: "yield",
      handoff_offered: "yield",
      handoff_refunded: "yield",
    };
  }
  // default to claim mode
  return {
    recipe_yielded: "yield",
    recipe_resumed: "resume",
    recipe_resolved_ok: "yield",
    handoff_offered: "yield",
    handoff_released: "yield",
  };
}

function findEventPlacement(
  src: CaptureSource,
  roles: TxRole[],
  recipe: RecipeName,
  name: string,
  ev: string,
): TxRole | null {
  for (const role of roles) {
    const tx = src.getTxByRole(role);
    if (!tx) continue;
    for (const outcome of tx.receipts_outcome) {
      const events = findTraceEvents(outcome.outcome.logs, recipe, name);
      if (events.some((e) => e.ev === ev)) return role;
    }
  }
  return null;
}

function computeDagPlacement(
  src: CaptureSource,
  recipe: RecipeName,
  name: string,
  opts?: { handoffMode?: "claim" | "timeout" },
): { placement: Record<string, TxRole | null>; violations: DagInvariantViolation[] } {
  const expected = expectedDagPlacement(recipe, opts);
  // Which captured tx roles to scan. Timeout paths capture only the yield
  // tx (no resume exists); everything else has both.
  const rolesToScan: TxRole[] =
    recipe === "timeout" || opts?.handoffMode === "timeout" ? ["yield"] : ["yield", "resume"];
  const placement: Record<string, TxRole | null> = {};
  const violations: DagInvariantViolation[] = [];
  for (const [ev, expectedRole] of Object.entries(expected)) {
    const actual = findEventPlacement(src, rolesToScan, recipe, name, ev);
    placement[ev] = actual;
    if (actual !== expectedRole) {
      violations.push({ event: ev, expected: expectedRole, actual });
    }
  }
  return { placement, violations };
}

// ---------------------------------------------------------------------------
// Audit artifact shapes
// ---------------------------------------------------------------------------

interface AuditBase {
  recipe: RecipeName;
  runIndex: number;
  name: string;
  signer: string;
  auditSource: "onchain_json" | "live_rpc";
  yieldTxHash: string;
  yieldBlockHeight: number | null;
  explorerUrl: string;
  interpretation: string;
  dagPlacement: Record<string, TxRole | null>;
  dagInvariantViolations: DagInvariantViolation[];
}

export interface BasicAudit extends AuditBase {
  recipe: "basic";
  resumeTxHash: string;
  resumeBlockHeight: number | null;
  callbackBlockHeight: number | null;
  resolvedOk: boolean;
  resolvedPayload: string | null;
  blocksFromYieldToResume: number | null;
  blocksFromResumeToCallback: number | null;
}

export interface TimeoutAudit extends AuditBase {
  recipe: "timeout";
  callbackBlockHeight: number | null;
  timeoutFired: boolean;
  blocksFromYieldToCallback: number | null;
}

export interface ChainedAudit extends AuditBase {
  recipe: "chained";
  counterId: string;
  delta: number;
  resumeTxHash: string;
  resumeBlockHeight: number | null;
  dispatchBlockHeight: number | null;
  callbackBlockHeight: number | null;
  observedValue: number | null;
  resolvedOk: boolean;
  blocksFromYieldToResume: number | null;
  blocksFromResumeToDispatch: number | null;
  blocksFromDispatchToCallback: number | null;
}

export interface HandoffAudit extends AuditBase {
  recipe: "handoff";
  mode: "claim" | "timeout";
  recipient: string;
  amountYocto: string;
  // Claim mode: resume tx signed by Bob; Timeout mode: null.
  resumeTxHash: string | null;
  claimSigner: string | null;
  resumeBlockHeight: number | null;
  // Settle block — where `handoff_released` (claim) or `handoff_refunded`
  // (timeout) landed. Both trace events live in the yield tx's DAG.
  settleBlockHeight: number | null;
  // Whether Alice's funds ended up with Bob (claim) or refunded to Alice
  // (timeout). Derived from `handoff_released` vs `handoff_refunded`.
  fundsRecipient: string | null;
  settledOk: boolean;
  blocksFromYieldToResume: number | null;
  // Timeout mode: y→settle ~= 200; claim mode: y→settle ~= yield_to_resume + 1–2.
  blocksFromYieldToSettle: number | null;
}

export type Audit = BasicAudit | TimeoutAudit | ChainedAudit | HandoffAudit;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function txBlockHeight(
  src: CaptureSource,
  tx: TxStatusResult | null,
): Promise<number | null> {
  if (!tx) return null;
  const block = await src.getBlockByHash(tx.transaction_outcome.block_hash);
  return block?.header.height ?? null;
}

// Walk all captured tx DAGs for the first receipt whose logs contain an
// event matching (recipe, name, evs). Returns its block height or null.
//
// IMPORTANT: the yielded callback receipt is scheduled by `Promise::new_yield`
// in the yield tx — not created anew by the resume tx. So when we look for
// `recipe_resolved_ok`, it may appear in the YIELD tx's DAG (basic +
// chained recipes) even though the resume tx is what triggered its
// execution. The resume tx's DAG typically contains only the `recipe_resumed`
// event. This helper searches all roles to be robust to that.
async function findEventBlockInAllTxs(
  src: CaptureSource,
  roles: string[],
  recipe: RecipeName,
  name: string,
  evs: string[],
): Promise<number | null> {
  for (const role of roles) {
    const tx = src.getTxByRole(role);
    if (!tx) continue;
    for (const outcome of tx.receipts_outcome) {
      const events = findTraceEvents(outcome.outcome.logs, recipe, name);
      if (events.some((e) => evs.includes(e.ev))) {
        const block = await src.getBlockByHash(outcome.block_hash);
        return block?.header.height ?? null;
      }
    }
  }
  return null;
}

function findObservedValueInAllTxs(
  src: CaptureSource,
  roles: string[],
  recipe: RecipeName,
  name: string,
): number | null {
  for (const role of roles) {
    const tx = src.getTxByRole(role);
    if (!tx) continue;
    for (const outcome of tx.receipts_outcome) {
      const events = findTraceEvents(outcome.outcome.logs, recipe, name);
      const obs = events.find((e) => e.ev === "recipe_callback_observed");
      if (obs?.value !== undefined) {
        const n = Number(obs.value);
        return Number.isFinite(n) ? n : null;
      }
    }
  }
  return null;
}

function findResolvedOutcomeInAllTxs(
  src: CaptureSource,
  roles: string[],
  recipe: RecipeName,
  name: string,
): { kind: "ok"; outcome: string } | { kind: "err"; reason: string } | null {
  for (const role of roles) {
    const tx = src.getTxByRole(role);
    if (!tx) continue;
    for (const outcome of tx.receipts_outcome) {
      const events = findTraceEvents(outcome.outcome.logs, recipe, name);
      for (const e of events) {
        if (e.ev === "recipe_resolved_ok") return { kind: "ok", outcome: e.outcome ?? "" };
        if (e.ev === "recipe_resolved_err") return { kind: "err", reason: e.reason ?? "" };
      }
    }
  }
  return null;
}

// The timeout recipe's callback receipt DOES appear in the yield tx's
// DAG — the yield registers the callback receipt at yield time, and the
// runtime delivers the timeout PromiseError to that same receipt when
// the 200-block budget elapses. So we just scan the captured tx DAG for
// the `recipe_resolved_err` trace event, no block-scan needed.
//
// (An earlier version did a 260-block scan assuming the callback was a
// fresh receipt materialized at timeout. That is not the case; the
// receipt was already in the DAG.)

// ---------------------------------------------------------------------------
// Per-recipe audit functions
// ---------------------------------------------------------------------------

async function auditBasic(raw: RawBasicArtifact, recipeDir: string): Promise<BasicAudit> {
  const src = buildCaptureSource(raw, recipeDir);
  const yieldTx = src.getTxByRole("yield");
  const resumeTx = src.getTxByRole("resume");
  const yieldHeight = await txBlockHeight(src, yieldTx);
  const resumeHeight = await txBlockHeight(src, resumeTx);

  // The yielded callback receipt was scheduled at yield time, so the
  // callback's trace events land in the YIELD tx's DAG even though the
  // resume tx triggers execution.
  const callbackHeight = await findEventBlockInAllTxs(
    src,
    ["yield", "resume"],
    "basic",
    raw.name,
    ["recipe_resolved_ok", "recipe_resolved_err"],
  );
  const resolved = findResolvedOutcomeInAllTxs(src, ["yield", "resume"], "basic", raw.name);

  const blocksFromYieldToResume =
    yieldHeight !== null && resumeHeight !== null ? resumeHeight - yieldHeight : null;
  const blocksFromResumeToCallback =
    resumeHeight !== null && callbackHeight !== null ? callbackHeight - resumeHeight : null;

  const interpretation =
    resolved?.kind === "ok"
      ? `resolved_ok with payload="${resolved.outcome}"; yield→resume=${blocksFromYieldToResume ?? "?"}b; resume→callback=${blocksFromResumeToCallback ?? "?"}b`
      : resolved?.kind === "err"
        ? `resolved_err reason="${resolved.reason}"`
        : "callback not observed in capture";

  const { placement, violations } = computeDagPlacement(src, "basic", raw.name);

  return {
    recipe: "basic",
    runIndex: raw.runIndex,
    name: raw.name,
    signer: raw.signer,
    auditSource: src.kind,
    yieldTxHash: raw.yieldTxHash,
    yieldBlockHeight: yieldHeight,
    resumeTxHash: raw.resumeTxHash,
    resumeBlockHeight: resumeHeight,
    callbackBlockHeight: callbackHeight,
    resolvedOk: resolved?.kind === "ok",
    resolvedPayload: resolved?.kind === "ok" ? resolved.outcome : null,
    blocksFromYieldToResume,
    blocksFromResumeToCallback,
    explorerUrl: `${EXPLORER_BASE}/txns/${raw.resumeTxHash}`,
    interpretation,
    dagPlacement: placement,
    dagInvariantViolations: violations,
  };
}

async function auditTimeout(raw: RawTimeoutArtifact, recipeDir: string): Promise<TimeoutAudit> {
  const src = buildCaptureSource(raw, recipeDir);
  const yieldTx = src.getTxByRole("yield");
  const yieldHeight = (await txBlockHeight(src, yieldTx)) ?? raw.yieldBlockHeight;

  const callbackBlockHeight = await findEventBlockInAllTxs(
    src,
    ["yield"],
    "timeout",
    raw.name,
    ["recipe_resolved_err", "recipe_resolved_ok"],
  );
  const resolved = findResolvedOutcomeInAllTxs(src, ["yield"], "timeout", raw.name);
  const timeoutFired = resolved?.kind === "err";

  const blocksFromYieldToCallback =
    yieldHeight !== null && callbackBlockHeight !== null ? callbackBlockHeight - yieldHeight : null;

  const interpretation = timeoutFired
    ? `timeout fired after ${blocksFromYieldToCallback ?? "?"} blocks (NEP-519 budget = 200)`
    : resolved?.kind === "ok"
      ? `unexpectedly resolved_ok with outcome="${resolved.outcome}"`
      : `timeout callback not located in captured yield tx DAG`;

  const { placement, violations } = computeDagPlacement(src, "timeout", raw.name);

  return {
    recipe: "timeout",
    runIndex: raw.runIndex,
    name: raw.name,
    signer: raw.signer,
    auditSource: src.kind,
    yieldTxHash: raw.yieldTxHash,
    yieldBlockHeight: yieldHeight,
    callbackBlockHeight,
    timeoutFired,
    blocksFromYieldToCallback,
    explorerUrl: `${EXPLORER_BASE}/txns/${raw.yieldTxHash}`,
    interpretation,
    dagPlacement: placement,
    dagInvariantViolations: violations,
  };
}

async function auditChained(raw: RawChainedArtifact, recipeDir: string): Promise<ChainedAudit> {
  const src = buildCaptureSource(raw, recipeDir);
  const yieldTx = src.getTxByRole("yield");
  const resumeTx = src.getTxByRole("resume");
  const yieldHeight = await txBlockHeight(src, yieldTx);
  const resumeHeight = await txBlockHeight(src, resumeTx);

  // The yielded callback receipt was scheduled at yield time; the resume
  // triggers execution of that already-scheduled receipt. Its trace
  // events + the chained counter-observation live in the YIELD tx's DAG.
  const dispatchHeight = await findEventBlockInAllTxs(
    src,
    ["yield", "resume"],
    "chained",
    raw.name,
    ["recipe_dispatched"],
  );
  const callbackHeight = await findEventBlockInAllTxs(
    src,
    ["yield", "resume"],
    "chained",
    raw.name,
    ["recipe_callback_observed"],
  );
  const observedValue = findObservedValueInAllTxs(src, ["yield", "resume"], "chained", raw.name);
  const resolved = findResolvedOutcomeInAllTxs(src, ["yield", "resume"], "chained", raw.name);

  const blocksFromYieldToResume =
    yieldHeight !== null && resumeHeight !== null ? resumeHeight - yieldHeight : null;
  const blocksFromResumeToDispatch =
    resumeHeight !== null && dispatchHeight !== null ? dispatchHeight - resumeHeight : null;
  const blocksFromDispatchToCallback =
    dispatchHeight !== null && callbackHeight !== null ? callbackHeight - dispatchHeight : null;

  const interpretation =
    resolved?.kind === "ok"
      ? `dispatched counter.${raw.delta > 0 ? "increment" : "decrement"}; observed=${observedValue ?? "?"}; ` +
        `yield→resume=${blocksFromYieldToResume ?? "?"}b; resume→dispatch=${blocksFromResumeToDispatch ?? "?"}b; dispatch→callback=${blocksFromDispatchToCallback ?? "?"}b`
      : resolved?.kind === "err"
        ? `chained resolved_err reason="${resolved.reason}"`
        : "chained callback not observed in capture";

  const { placement, violations } = computeDagPlacement(src, "chained", raw.name);

  return {
    recipe: "chained",
    runIndex: raw.runIndex,
    name: raw.name,
    signer: raw.signer,
    auditSource: src.kind,
    counterId: raw.counterId,
    delta: raw.delta,
    yieldTxHash: raw.yieldTxHash,
    yieldBlockHeight: yieldHeight,
    resumeTxHash: raw.resumeTxHash,
    resumeBlockHeight: resumeHeight,
    dispatchBlockHeight: dispatchHeight,
    callbackBlockHeight: callbackHeight,
    observedValue,
    resolvedOk: resolved?.kind === "ok",
    blocksFromYieldToResume,
    blocksFromResumeToDispatch,
    blocksFromDispatchToCallback,
    explorerUrl: `${EXPLORER_BASE}/txns/${raw.resumeTxHash}`,
    interpretation,
    dagPlacement: placement,
    dagInvariantViolations: violations,
  };
}

// ---------------------------------------------------------------------------
// Recipe 4: Atomic handoff audit
// ---------------------------------------------------------------------------
//
// Both modes capture the yield tx; claim mode additionally captures the
// resume tx. All handoff-specific trace events (handoff_offered /
// handoff_released / handoff_refunded) live in the yield tx's DAG
// because the callback receipt — where the settle-path transfer happens
// — was scheduled at yield time. This is the same property the basic
// and chained recipes demonstrate, but here it carries economic value.

function findSettleEventInAllTxs(
  src: CaptureSource,
  roles: TxRole[],
  name: string,
): { ev: "handoff_released" | "handoff_refunded"; body: TraceLogBody } | null {
  for (const role of roles) {
    const tx = src.getTxByRole(role);
    if (!tx) continue;
    for (const outcome of tx.receipts_outcome) {
      const events = findTraceEvents(outcome.outcome.logs, "handoff", name);
      for (const e of events) {
        if (e.ev === "handoff_released") return { ev: "handoff_released", body: e };
        if (e.ev === "handoff_refunded") return { ev: "handoff_refunded", body: e };
      }
    }
  }
  return null;
}

async function auditHandoff(raw: RawHandoffArtifact, recipeDir: string): Promise<HandoffAudit> {
  const src = buildCaptureSource(raw, recipeDir);
  const yieldTx = src.getTxByRole("yield");
  const resumeTx = raw.resumeTxHash ? src.getTxByRole("resume") : null;
  const yieldHeight = (await txBlockHeight(src, yieldTx)) ?? raw.yieldBlockHeight;
  const resumeHeight = resumeTx ? await txBlockHeight(src, resumeTx) : null;

  const rolesToScan: TxRole[] = raw.mode === "timeout" ? ["yield"] : ["yield", "resume"];
  const settleBlockHeight = await findEventBlockInAllTxs(
    src,
    rolesToScan,
    "handoff",
    raw.name,
    ["handoff_released", "handoff_refunded"],
  );
  const settleEvent = findSettleEventInAllTxs(src, rolesToScan, raw.name);
  const fundsRecipient =
    settleEvent?.ev === "handoff_released"
      ? (settleEvent.body.to ?? null)
      : settleEvent?.ev === "handoff_refunded"
        ? (settleEvent.body.refunded_to ?? null)
        : null;
  const settledOk = settleEvent?.ev === "handoff_released";

  const blocksFromYieldToResume =
    yieldHeight !== null && resumeHeight !== null ? resumeHeight - yieldHeight : null;
  const blocksFromYieldToSettle =
    yieldHeight !== null && settleBlockHeight !== null ? settleBlockHeight - yieldHeight : null;

  const { placement, violations } = computeDagPlacement(src, "handoff", raw.name, {
    handoffMode: raw.mode,
  });

  const interpretation =
    raw.mode === "claim"
      ? settledOk
        ? `claim: ${raw.amountYocto} yocto → ${fundsRecipient}; yield→resume=${blocksFromYieldToResume ?? "?"}b; yield→settle=${blocksFromYieldToSettle ?? "?"}b`
        : `claim: settle not observed in capture`
      : settleEvent?.ev === "handoff_refunded"
        ? `timeout: refunded ${raw.amountYocto} yocto → ${fundsRecipient}; yield→settle=${blocksFromYieldToSettle ?? "?"}b (NEP-519 budget = 200)`
        : `timeout: refund not observed in captured yield tx DAG`;

  return {
    recipe: "handoff",
    mode: raw.mode,
    runIndex: raw.runIndex,
    name: raw.name,
    signer: raw.signer,
    auditSource: src.kind,
    recipient: raw.recipient,
    amountYocto: raw.amountYocto,
    yieldTxHash: raw.yieldTxHash,
    yieldBlockHeight: yieldHeight,
    resumeTxHash: raw.resumeTxHash,
    claimSigner: raw.claimSigner,
    resumeBlockHeight: resumeHeight,
    settleBlockHeight,
    fundsRecipient,
    settledOk,
    blocksFromYieldToResume,
    blocksFromYieldToSettle,
    explorerUrl: `${EXPLORER_BASE}/txns/${raw.yieldTxHash}`,
    interpretation,
    dagPlacement: placement,
    dagInvariantViolations: violations,
  };
}

// ---------------------------------------------------------------------------
// Dispatch
// ---------------------------------------------------------------------------

export async function auditOneRun(raw: RawArtifact, recipeDir: string): Promise<Audit> {
  switch (raw.recipe) {
    case "basic":
      return auditBasic(raw, recipeDir);
    case "timeout":
      return auditTimeout(raw, recipeDir);
    case "chained":
      return auditChained(raw, recipeDir);
    case "handoff":
      return auditHandoff(raw, recipeDir);
  }
}

export async function auditRecipe(recipe: RecipeName): Promise<Audit[]> {
  const dir = join(ARTIFACTS_DIR, `recipe-${recipe}`);
  const entries = readdirSync(dir)
    .filter((f) => f.endsWith(".raw.json"))
    .sort();
  const audits: Audit[] = [];
  for (const entry of entries) {
    process.stderr.write(`[audit ${recipe}] ${entry}...\n`);
    const raw = JSON.parse(readFileSync(join(dir, entry), "utf8")) as RawArtifact;
    if (raw.recipe !== recipe) {
      process.stderr.write(`[audit ${recipe}]   skipping: recipe mismatch (${raw.recipe})\n`);
      continue;
    }
    const audit = await auditOneRun(raw, dir);
    const outName = entry.replace(/\.raw\.json$/, ".audit.json");
    writeFileSync(join(dir, outName), JSON.stringify(audit, null, 2));
    process.stderr.write(`[audit ${recipe}]   (${audit.auditSource}) ${audit.interpretation}\n`);
    if (audit.dagInvariantViolations.length > 0) {
      process.stderr.write(
        `[audit ${recipe}]   !! DAG-placement invariant violated (${audit.dagInvariantViolations.length}):\n`,
      );
      for (const v of audit.dagInvariantViolations) {
        process.stderr.write(
          `[audit ${recipe}]      ${v.event}: expected in ${v.expected} tx DAG, found in ${v.actual ?? "no captured tx"}\n`,
        );
      }
    }
    audits.push(audit);
  }
  return audits;
}
