// Per-recipe audits + the four NEP-519 invariants the demo proves.
//
// Each audit reads a run's raw + onchain.json files and produces a
// lifecycle summary as run-NN.audit.json. The audit is also where the
// four machine-checked invariants are enforced — the substantive proof
// that the `recipes` contract achieves contract-controlled sequential
// receipt execution across block boundaries on NEAR mainnet:
//
//   DAG-placement    (computeDagPlacement)  — pause is real:
//     callback trace events live in the YIELD tx's DAG, not the
//     resume tx's, because the callback receipt is scheduled at yield
//     time and the runtime only delivers a payload to it on resume.
//   Budget           (checkBudget)          — wait is bounded:
//     observed yield→callback block delta ∈ [200, 205] on timeout
//     paths, NEP-519's stated budget plus small inclusion slack.
//   Atomicity        (checkAtomicity)       — resume composes with value:
//     Recipe 4's callback atomically emits a Transfer to the
//     yield-time-nominated recipient, with SuccessValue outcome.
//   Shard-placement  (computeShardPlacement) — route-back is real:
//     callback-emitting receipts execute on the contract's home
//     shard regardless of the resume tx's origin shard; observed
//     via `outcome.executor_id == recipes contract`.
//
// A violation of any invariant prints a loud `!!` stderr line and
// exits non-zero. See docs/invariants.md for the per-invariant
// derivation from NEP-519 semantics, and docs/verification.md for
// three independent verification paths a reader can run locally.
//
// The per-recipe summary shape differs because each recipe has
// different observable moments:
//
//   basic   — yielded, resumed, resolved_ok
//   timeout — yielded, resolved_err (after block-scan to find callback)
//   chained — yielded, resumed, dispatched, callback_observed, resolved_ok
//   handoff — yielded + handoff_offered, (optional) resumed,
//             on claim: resolved_ok + handoff_released + Transfer receipt
//             on timeout: resolved_err + handoff_refunded + refund receipt
//
// All four share: parsed trace events keyed by event name + name, plus
// block-height deltas between observable moments. The aggregate + report
// layers consume these to build the recipe-book artifact.

import { existsSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { ACCOUNTS, ARTIFACTS_DIR, EXPLORER_BASE } from "./config.js";
import {
  blockByHash,
  blockByHeight,
  chunkByHash,
  type BlockResult,
  type ChunkResult,
  type TxStatusResult,
} from "./rpc.js";
import { snapshotOnChain, writeOnchainSnapshot, type OnchainSnapshot, type SnapshotStatus, type SnapshotTx } from "./snapshot.js";
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
// Snapshot source
// ---------------------------------------------------------------------------
//
// Audits read receipt DAGs from the cached `run-NN.onchain.json` beside each
// `run-NN.raw.json`. When the onchain.json is absent, the auditor rebuilds it
// by calling `snapshotOnChain(...)` against the archival RPC (the same flow
// that wrote it originally) and writes the result back to the same path.
// This is the critical behavior that powers docs/verification.md's "path 3"
// — a reader can `rm *.onchain.json` and re-audit to independently
// reconstruct the snapshots from archival without trusting the committed
// snapshot bytes.
//
// There is intentionally no "live-RPC audit" mode that skips writing the
// snapshot to disk: such a mode once existed but deviated from the
// snapshotted code path (different caching shape, no chunk coverage) and
// never produced correct invariant results. Audits always run against a
// materialized on-disk snapshot.

interface SnapshotSource {
  kind: "onchain_json";
  // Overall snapshot health propagated from onchain.json.
  snapshotStatus: SnapshotStatus;
  getTxByRole(role: string): TxStatusResult | null;
  getBlockByHash(hash: string): Promise<BlockResult | null>;
  getBlockByHeight(height: number): Promise<BlockResult | null>;
  getChunkByHash(hash: string): Promise<ChunkResult | null>;
}

// Default for on-disk onchain.json files that predate the snapshotStatus
// field. Treat absence as "complete" so we never falsely report failures.
const COMPLETE_SNAPSHOT_STATUS: SnapshotStatus = {
  overall: "complete",
  txStatusFailures: [],
  blockFailures: [],
  chunkFailures: [],
};

// Per-recipe role -> tx-hash mapping. Shared by `buildSnapshotTxs` (for
// on-demand re-snapshot) and historically by the removed live-RPC source.
function snapshotTxsForRaw(raw: RawArtifact): SnapshotTx[] {
  const txs: SnapshotTx[] = [];
  if (raw.recipe === "basic" || raw.recipe === "chained") {
    txs.push({ role: "yield", hash: raw.yieldTxHash, signer: raw.signer });
    txs.push({ role: "resume", hash: raw.resumeTxHash, signer: raw.signer });
  } else if (raw.recipe === "timeout") {
    txs.push({ role: "yield", hash: raw.yieldTxHash, signer: raw.signer });
  } else {
    // handoff: resumeTxHash is null in timeout mode.
    txs.push({ role: "yield", hash: raw.yieldTxHash, signer: raw.signer });
    if (raw.resumeTxHash) {
      // Claim-mode runs use the claim signer (usually master) for resume.
      const resumeSigner = raw.mode === "claim" ? (raw.claimSigner ?? raw.signer) : raw.signer;
      txs.push({ role: "resume", hash: raw.resumeTxHash, signer: resumeSigner });
    }
  }
  return txs;
}

async function buildSnapshotSource(raw: RawArtifact, recipeDir: string): Promise<SnapshotSource> {
  // Handoff writes mode-prefixed filenames (e.g. run-claim-01.onchain.json)
  // so claim/timeout runs can share the dir without collisions. Other
  // recipes use plain zero-padded runIndex.
  const suffix =
    raw.recipe === "handoff"
      ? `${raw.mode}-${raw.runIndex.toString().padStart(2, "0")}`
      : raw.runIndex.toString().padStart(2, "0");
  const onchainPath = join(recipeDir, `run-${suffix}.onchain.json`);
  if (existsSync(onchainPath)) {
    const snapshot = JSON.parse(readFileSync(onchainPath, "utf8")) as OnchainSnapshot;
    return localSource(snapshot);
  }
  // Missing snapshot — rebuild from archival RPC and persist. See the
  // module-level comment above; docs/verification.md path 3 depends on
  // this being the single auditor entry point.
  process.stderr.write(
    `[audit]   no snapshot at ${onchainPath}; re-fetching from archival RPC...\n`,
  );
  const txs = snapshotTxsForRaw(raw);
  const snapshot = await snapshotOnChain(txs);
  if (snapshot.snapshotStatus.overall === "failed") {
    throw new Error(
      `archival re-fetch failed: yield tx ${raw.yieldTxHash.slice(0, 10)} not available. ` +
        `Check FastNEAR archival retention; fall back to an alternate archival provider via RPC_AUDIT env.`,
    );
  }
  writeOnchainSnapshot(onchainPath, snapshot);
  const nBlocks = Object.keys(snapshot.blocks).length;
  const nChunks = Object.keys(snapshot.chunks).length;
  process.stderr.write(
    `[audit]   wrote ${onchainPath} (${nBlocks} blocks, ${nChunks} chunks, status=${snapshot.snapshotStatus.overall})\n`,
  );
  return localSource(snapshot);
}

function localSource(snapshot: OnchainSnapshot): SnapshotSource {
  const blocksByHash = new Map(Object.entries(snapshot.blocks));
  const blocksByHeight = new Map<number, BlockResult>();
  for (const b of blocksByHash.values()) blocksByHeight.set(b.header.height, b);
  const chunksByHash = new Map(Object.entries(snapshot.chunks));
  return {
    kind: "onchain_json",
    snapshotStatus: snapshot.snapshotStatus ?? COMPLETE_SNAPSHOT_STATUS,
    getTxByRole(role) {
      return snapshot.txStatus[role] ?? null;
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
// Full derivation + rationale: ../../docs/invariants.md#1-dag-placement
//
// NEP-519 semantics: `Promise::new_yield` schedules the callback receipt at
// yield time. `yield_id.resume(payload)` delivers a payload to that
// already-scheduled receipt; it does NOT create a new one. The 200-block
// timeout path is the same — the runtime delivers `PromiseError` to the
// existing receipt. Consequence: all trace events emitted by callback code
// (`recipe_resolved_*`, `recipe_dispatched`, `recipe_callback_observed`,
// `handoff_released`, `handoff_refunded`) land in the YIELD tx's
// `receipts_outcome[]`, not the resume tx's.
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
  src: SnapshotSource,
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
  src: SnapshotSource,
  recipe: RecipeName,
  name: string,
  opts?: { handoffMode?: "claim" | "timeout" },
): { placement: Record<string, TxRole | null>; violations: DagInvariantViolation[] } {
  const expected = expectedDagPlacement(recipe, opts);
  // Which snapshotted tx roles to scan. Timeout paths snapshot only the
  // yield tx (no resume exists); everything else has both.
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
// Budget invariant (NEP-519 200-block timeout)
// ---------------------------------------------------------------------------
//
// Full derivation + rationale: ../../docs/invariants.md#2-budget
//
// NEP-519 specifies a 200-block yield budget. When the budget elapses, the
// runtime delivers `PromiseError` to the already-scheduled callback receipt,
// which then executes in the next chunk-production slot. So the observed
// yield→callback block delta is ~200 + a few blocks of execution latency.
//
// Bounds: [200, 205]. 200 = the protocol's stated budget. +5 upper slack
// covers normal chunk-inclusion jitter and gives the callback receipt a
// small window to land. A drift outside this range suggests either a
// protocol-level change (budget bumped, block timing shifted) or a
// snapshot that missed the callback's receipt outcome; either way the
// reader should be told rather than the number rendered silently.

export const BUDGET_LOWER_BLOCKS = 200;
export const BUDGET_UPPER_BLOCKS = 205;

export interface BudgetInvariantResult {
  held: boolean;
  // False when `observedBlocks` is null (the callback receipt wasn't
  // located in the snapshot). Treated as "inconclusive" rather than
  // "violated" so a missing snapshot doesn't fire a false alarm.
  evaluable: boolean;
  observedBlocks: number | null;
  lowerBound: number;
  upperBound: number;
}

export function checkBudget(blocks: number | null): BudgetInvariantResult {
  if (blocks === null) {
    return {
      held: true,
      evaluable: false,
      observedBlocks: null,
      lowerBound: BUDGET_LOWER_BLOCKS,
      upperBound: BUDGET_UPPER_BLOCKS,
    };
  }
  return {
    held: blocks >= BUDGET_LOWER_BLOCKS && blocks <= BUDGET_UPPER_BLOCKS,
    evaluable: true,
    observedBlocks: blocks,
    lowerBound: BUDGET_LOWER_BLOCKS,
    upperBound: BUDGET_UPPER_BLOCKS,
  };
}

// ---------------------------------------------------------------------------
// Atomicity invariant (Recipe 4)
// ---------------------------------------------------------------------------
//
// Full derivation + rationale: ../../docs/invariants.md#3-atomicity-recipe-4
//
// Recipe 4's central claim: the yield/resume primitive moves value
// atomically. On claim, exactly `amountYocto` flows from the recipes
// contract to the nominated recipient; on timeout, exactly `amountYocto`
// flows back to the signer. We verify empirically by scanning the
// snapshotted tx DAG for a Transfer action receipt that satisfies all
// four conditions: predecessor = recipes contract, receiver = expected
// recipient (Bob for claim, Alice for timeout), deposit = expected amount,
// and the receipt's outcome status is `SuccessValue`.
//
// The Transfer receipt always lives in the yield tx's DAG — same DAG as
// the `handoff_released` / `handoff_refunded` trace event — because the
// callback that schedules the transfer was itself registered at yield
// time. Finding it there is additional evidence for the DAG-placement
// invariant; the delta-check is the separate empirical claim on value.

export interface AtomicityInvariantResult {
  held: boolean;
  // False when no Transfer receipt matching `expectedRecipient` was
  // found in the snapshot — the claim/refund never happened or wasn't
  // snapshotted. Treated as "inconclusive" (still a problem, but not
  // "the primitive moved the wrong amount").
  evaluable: boolean;
  mode: "claim" | "timeout";
  expectedRecipient: string;
  expectedAmountYocto: string;
  observed: {
    receiptId: string;
    receiverId: string;
    depositYocto: string;
    succeeded: boolean;
  } | null;
}

function findHandoffTransfer(
  src: SnapshotSource,
  rolesToScan: TxRole[],
  contractId: string,
  expectedRecipient: string,
): AtomicityInvariantResult["observed"] {
  for (const role of rolesToScan) {
    const tx = src.getTxByRole(role);
    if (!tx) continue;
    for (const r of tx.receipts) {
      if (r.predecessor_id !== contractId) continue;
      if (r.receiver_id !== expectedRecipient) continue;
      const actions = r.receipt?.Action?.actions ?? [];
      for (const a of actions) {
        const transfer = (a as { Transfer?: { deposit: string } }).Transfer;
        if (!transfer) continue;
        const outcome = tx.receipts_outcome.find((o) => o.id === r.receipt_id);
        const succeeded =
          outcome !== undefined &&
          typeof outcome.outcome.status === "object" &&
          outcome.outcome.status !== null &&
          "SuccessValue" in outcome.outcome.status;
        return {
          receiptId: r.receipt_id,
          receiverId: r.receiver_id,
          depositYocto: transfer.deposit,
          succeeded,
        };
      }
    }
  }
  return null;
}

function checkAtomicity(
  src: SnapshotSource,
  mode: "claim" | "timeout",
  signer: string,
  recipient: string,
  amountYocto: string,
  contractId: string,
): AtomicityInvariantResult {
  const expectedRecipient = mode === "claim" ? recipient : signer;
  const rolesToScan: TxRole[] = mode === "timeout" ? ["yield"] : ["yield", "resume"];
  const observed = findHandoffTransfer(src, rolesToScan, contractId, expectedRecipient);
  const held =
    observed !== null &&
    observed.receiverId === expectedRecipient &&
    observed.depositYocto === amountYocto &&
    observed.succeeded;
  return {
    held,
    evaluable: observed !== null,
    mode,
    expectedRecipient,
    expectedAmountYocto: amountYocto,
    observed,
  };
}

// ---------------------------------------------------------------------------
// Shard-placement invariant
// ---------------------------------------------------------------------------
//
// Full derivation + rationale: ../../docs/invariants.md#4-shard-placement
//
// NEP-519 schedules the callback receipt at yield time with
// `receiver_id = <recipes contract>`. In NEAR's sharded execution
// model, every receipt is routed to and executed on the shard that
// owns the receiver's account — the directly observable form is
// `outcome.executor_id`, which must be the contract for every
// callback-emitting receipt. This is equivalent to "the callback
// executed on the contract's home shard" under the protocol-level
// fact that an account's shard is determined by its account hash.
//
// On a multi-shard network (testnet ~12, mainnet 4–6), the resume-side
// signer (e.g. `alice.*`) may live on a different shard than
// `recipes.*`. The invariant is what makes cross-shard receipt
// forwarding a correctness-preserving operation: the callback stays put
// on the contract's shard, only the payload crosses the shard boundary.
//
// The contract's home shard is reported for transparency (so readers
// can see "callbacks ran on shard 4" explicitly in the report). It's
// derived empirically from the first FunctionCall receipt in the yield
// tx's DAG whose chunk is locatable — typically the initial
// `signer → contract` action receipt, which appears in the chunk's
// `receipts[]` at delivery time. Yielded callback receipts are
// delivered from the protocol's yielded-receipts queue rather than
// the standard cross-shard routing path, so they don't show up in
// `chunk.receipts[]`; the home-shard anchor therefore comes from the
// pre-yield receipt, not the callback itself.

// Callback events whose emitting receipts must land on the contract's
// home shard. Intentionally excludes `recipe_yielded` (emitted by the
// initial yield receipt — trivially on the contract's shard because
// that's the receiver) and `recipe_resumed` (emitted by the resume
// method itself — a separate FunctionCall receipt on the resume-tx
// path). See docs/invariants.md#4-shard-placement for the full list.
const SHARD_CALLBACK_EVENTS = [
  "recipe_resolved_ok",
  "recipe_resolved_err",
  "recipe_dispatched",
  "recipe_callback_observed",
  "handoff_released",
  "handoff_refunded",
];

export interface ShardInvariantViolation {
  receiptId: string;
  executorId: string;
  event: string;
  // Diagnostic: set if the chunk containing this receipt was locatable
  // in the snapshot. Yielded callback receipts typically can't be
  // located this way (see module-level comment), so this is best-effort.
  observedShard: number | null;
}

export interface ShardInvariantResult {
  held: boolean;
  // False when no callback receipts were present to check. Treat as
  // "inconclusive" rather than "violated."
  evaluable: boolean;
  contractId: string;
  // Empirically derived from the first FunctionCall receipt to the
  // contract whose chunk was findable; reported for transparency. null
  // means no such receipt was locatable (e.g., live-RPC source with
  // stale archive) — doesn't itself cause a violation since the
  // executor_id check doesn't depend on it.
  contractShard: number | null;
  receiptsChecked: number;
  wrongShardReceipts: ShardInvariantViolation[];
}

async function findChunkForReceipt(
  src: SnapshotSource,
  blockHash: string,
  receiptId: string,
): Promise<{ chunkHash: string; shardId: number } | null> {
  const block = await src.getBlockByHash(blockHash);
  if (!block) return null;
  for (const chunkMeta of block.chunks) {
    const chunk = await src.getChunkByHash(chunkMeta.chunk_hash);
    if (!chunk) continue;
    if (chunk.receipts.some((r) => r.receipt_id === receiptId)) {
      return { chunkHash: chunk.header.chunk_hash, shardId: chunk.header.shard_id };
    }
  }
  return null;
}

// Home shard is anchored from any FunctionCall receipt whose chunk can
// be located AND whose executor is the contract. The initial
// `signer → contract` action receipt satisfies both reliably (it
// appears in the chunk's receipts[] at delivery time, with
// executor_id = contract). Yielded callback receipts don't appear in
// chunk.receipts[] — they're delivered out-of-band — so they can't
// serve as the anchor.
async function findContractHomeShard(
  src: SnapshotSource,
  rolesToScan: TxRole[],
  contractId: string,
): Promise<number | null> {
  for (const role of rolesToScan) {
    const tx = src.getTxByRole(role);
    if (!tx) continue;
    for (const outcome of tx.receipts_outcome) {
      if (outcome.outcome.executor_id !== contractId) continue;
      const chunk = await findChunkForReceipt(src, outcome.block_hash, outcome.id);
      if (chunk) return chunk.shardId;
    }
  }
  return null;
}

async function computeShardPlacement(
  src: SnapshotSource,
  recipe: RecipeName,
  name: string,
  contractId: string,
  opts?: { handoffMode?: "claim" | "timeout" },
): Promise<ShardInvariantResult> {
  const rolesToScan: TxRole[] =
    recipe === "timeout" || opts?.handoffMode === "timeout" ? ["yield"] : ["yield", "resume"];
  const contractShard = await findContractHomeShard(src, rolesToScan, contractId);
  const wrong: ShardInvariantViolation[] = [];
  let receiptsChecked = 0;
  for (const role of rolesToScan) {
    const tx = src.getTxByRole(role);
    if (!tx) continue;
    for (const outcome of tx.receipts_outcome) {
      const events = findTraceEvents(outcome.outcome.logs, recipe, name);
      const callback = events.find((e) => SHARD_CALLBACK_EVENTS.includes(e.ev));
      if (!callback) continue;
      receiptsChecked++;
      if (outcome.outcome.executor_id !== contractId) {
        // Best-effort chunk lookup for diagnostic output. Almost
        // always returns null for yielded callback receipts (by
        // design of the yielded-delivery path); not a problem.
        const chunk = await findChunkForReceipt(src, outcome.block_hash, outcome.id);
        wrong.push({
          receiptId: outcome.id,
          executorId: outcome.outcome.executor_id,
          event: callback.ev,
          observedShard: chunk?.shardId ?? null,
        });
      }
    }
  }
  const evaluable = receiptsChecked > 0;
  const held = evaluable && wrong.length === 0;
  return {
    held,
    evaluable,
    contractId,
    contractShard,
    receiptsChecked,
    wrongShardReceipts: wrong,
  };
}

// ---------------------------------------------------------------------------
// Audit artifact shapes
// ---------------------------------------------------------------------------

interface AuditBase {
  recipe: RecipeName;
  runIndex: number;
  name: string;
  signer: string;
  // Always "onchain_json" since the only SnapshotSource kind is the
  // on-disk snapshot (re-fetched from archival on demand if missing).
  // Kept as a named field rather than a boolean so the report layer can
  // surface the source without reading the env or the snapshot itself.
  auditSource: "onchain_json";
  // Whether the underlying snapshot was complete, partial, or failed.
  // Lets the report tell apart "no value because snapshot dropped" from
  // "no value because the field doesn't apply to this recipe". Optional
  // for back-compat with audit.json files written before the field
  // existed; consumers should treat absence as "complete".
  snapshotStatus?: SnapshotStatus;
  yieldTxHash: string;
  yieldBlockHeight: number | null;
  explorerUrl: string;
  interpretation: string;
  dagPlacement: Record<string, TxRole | null>;
  dagInvariantViolations: DagInvariantViolation[];
  // Shard-placement invariant: every callback-emitted trace event
  // executed on the contract's home shard. Optional for back-compat
  // with audit.json files written before the field existed; consumers
  // should treat absence as "inconclusive" (evaluable=false).
  shardInvariant?: ShardInvariantResult;
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
  // NEP-519 200-block budget empirically checked against
  // blocksFromYieldToCallback. See `checkBudget` in this module for bounds.
  budgetInvariant: BudgetInvariantResult;
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
  // Atomicity: Transfer receipt matching (recipient, amount, success).
  // Populated for both modes; `expectedRecipient` differs (Bob in claim;
  // signer in timeout). See `checkAtomicity` in this module.
  atomicityInvariant: AtomicityInvariantResult;
  // NEP-519 200-block budget — only applicable in timeout mode. Undefined
  // for claim runs (claim fires at resumer's pace, no budget to check).
  budgetInvariant?: BudgetInvariantResult;
}

export type Audit = BasicAudit | TimeoutAudit | ChainedAudit | HandoffAudit;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function txBlockHeight(
  src: SnapshotSource,
  tx: TxStatusResult | null,
): Promise<number | null> {
  if (!tx) return null;
  const block = await src.getBlockByHash(tx.transaction_outcome.block_hash);
  return block?.header.height ?? null;
}

// Walk all snapshotted tx DAGs for the first receipt whose logs contain an
// event matching (recipe, name, evs). Returns its block height or null.
//
// IMPORTANT: the yielded callback receipt is scheduled by `Promise::new_yield`
// in the yield tx — not created anew by the resume tx. So when we look for
// `recipe_resolved_ok`, it may appear in the YIELD tx's DAG (basic +
// chained recipes) even though the resume tx is what triggered its
// execution. The resume tx's DAG typically contains only the `recipe_resumed`
// event. This helper searches all roles to be robust to that.
async function findEventBlockInAllTxs(
  src: SnapshotSource,
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
  src: SnapshotSource,
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
  src: SnapshotSource,
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
// the 200-block budget elapses. So we just scan the snapshotted tx DAG for
// the `recipe_resolved_err` trace event, no block-scan needed.
//
// (An earlier version did a 260-block scan assuming the callback was a
// fresh receipt materialized at timeout. That is not the case; the
// receipt was already in the DAG.)

// ---------------------------------------------------------------------------
// Per-recipe audit functions
// ---------------------------------------------------------------------------

async function auditBasic(raw: RawBasicArtifact, recipeDir: string): Promise<BasicAudit> {
  const src = await buildSnapshotSource(raw, recipeDir);
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
        : "callback not observed in snapshot";

  const { placement, violations } = computeDagPlacement(src, "basic", raw.name);
  const shardInvariant = await computeShardPlacement(src, "basic", raw.name, ACCOUNTS.recipes);

  return {
    recipe: "basic",
    runIndex: raw.runIndex,
    name: raw.name,
    signer: raw.signer,
    auditSource: src.kind,
    snapshotStatus: src.snapshotStatus,
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
    shardInvariant,
  };
}

async function auditTimeout(raw: RawTimeoutArtifact, recipeDir: string): Promise<TimeoutAudit> {
  const src = await buildSnapshotSource(raw, recipeDir);
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
      : `timeout callback not located in snapshotted yield tx DAG`;

  const { placement, violations } = computeDagPlacement(src, "timeout", raw.name);
  const budgetInvariant = checkBudget(blocksFromYieldToCallback);
  const shardInvariant = await computeShardPlacement(src, "timeout", raw.name, ACCOUNTS.recipes);

  return {
    recipe: "timeout",
    runIndex: raw.runIndex,
    name: raw.name,
    signer: raw.signer,
    auditSource: src.kind,
    snapshotStatus: src.snapshotStatus,
    yieldTxHash: raw.yieldTxHash,
    yieldBlockHeight: yieldHeight,
    callbackBlockHeight,
    timeoutFired,
    blocksFromYieldToCallback,
    explorerUrl: `${EXPLORER_BASE}/txns/${raw.yieldTxHash}`,
    interpretation,
    dagPlacement: placement,
    dagInvariantViolations: violations,
    budgetInvariant,
    shardInvariant,
  };
}

async function auditChained(raw: RawChainedArtifact, recipeDir: string): Promise<ChainedAudit> {
  const src = await buildSnapshotSource(raw, recipeDir);
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
        : "chained callback not observed in snapshot";

  const { placement, violations } = computeDagPlacement(src, "chained", raw.name);
  const shardInvariant = await computeShardPlacement(src, "chained", raw.name, ACCOUNTS.recipes);

  return {
    recipe: "chained",
    runIndex: raw.runIndex,
    name: raw.name,
    signer: raw.signer,
    auditSource: src.kind,
    snapshotStatus: src.snapshotStatus,
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
    shardInvariant,
  };
}

// ---------------------------------------------------------------------------
// Recipe 4: Atomic handoff audit
// ---------------------------------------------------------------------------
//
// Both modes snapshot the yield tx; claim mode additionally snapshots the
// resume tx. All handoff-specific trace events (handoff_offered /
// handoff_released / handoff_refunded) live in the yield tx's DAG
// because the callback receipt — where the settle-path transfer happens
// — was scheduled at yield time. This is the same property the basic
// and chained recipes demonstrate, but here it carries economic value.

function findSettleEventInAllTxs(
  src: SnapshotSource,
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
  const src = await buildSnapshotSource(raw, recipeDir);
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
  const atomicityInvariant = checkAtomicity(
    src,
    raw.mode,
    raw.signer,
    raw.recipient,
    raw.amountYocto,
    ACCOUNTS.recipes,
  );
  // Budget invariant applies only to timeout runs; claim runs settle at
  // the resumer's pace so there's no 200-block budget to check.
  const budgetInvariant =
    raw.mode === "timeout" ? checkBudget(blocksFromYieldToSettle) : undefined;
  const shardInvariant = await computeShardPlacement(src, "handoff", raw.name, ACCOUNTS.recipes, {
    handoffMode: raw.mode,
  });

  const interpretation =
    raw.mode === "claim"
      ? settledOk
        ? `claim: ${raw.amountYocto} yocto → ${fundsRecipient}; yield→resume=${blocksFromYieldToResume ?? "?"}b; yield→settle=${blocksFromYieldToSettle ?? "?"}b`
        : `claim: settle not observed in snapshot`
      : settleEvent?.ev === "handoff_refunded"
        ? `timeout: refunded ${raw.amountYocto} yocto → ${fundsRecipient}; yield→settle=${blocksFromYieldToSettle ?? "?"}b (NEP-519 budget = 200)`
        : `timeout: refund not observed in snapshotted yield tx DAG`;

  return {
    recipe: "handoff",
    mode: raw.mode,
    runIndex: raw.runIndex,
    name: raw.name,
    signer: raw.signer,
    auditSource: src.kind,
    snapshotStatus: src.snapshotStatus,
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
    atomicityInvariant,
    shardInvariant,
    ...(budgetInvariant ? { budgetInvariant } : {}),
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
          `[audit ${recipe}]      ${v.event}: expected in ${v.expected} tx DAG, found in ${v.actual ?? "no snapshotted tx"}\n`,
        );
      }
    }
    const budget = (audit as { budgetInvariant?: BudgetInvariantResult }).budgetInvariant;
    if (budget && budget.evaluable && !budget.held) {
      process.stderr.write(
        `[audit ${recipe}]   !! budget invariant violated: yield→callback=${budget.observedBlocks} not in [${budget.lowerBound}, ${budget.upperBound}] (NEP-519 spec = 200)\n`,
      );
    }
    const atomicity = (audit as { atomicityInvariant?: AtomicityInvariantResult }).atomicityInvariant;
    if (atomicity && atomicity.evaluable && !atomicity.held) {
      process.stderr.write(
        `[audit ${recipe}]   !! atomicity invariant violated: expected Transfer(${atomicity.expectedRecipient}, ${atomicity.expectedAmountYocto}) ` +
          `observed (${atomicity.observed?.receiverId}, ${atomicity.observed?.depositYocto}, succeeded=${atomicity.observed?.succeeded})\n`,
      );
    } else if (atomicity && !atomicity.evaluable) {
      process.stderr.write(
        `[audit ${recipe}]   !! atomicity invariant inconclusive: no Transfer receipt to ${atomicity.expectedRecipient} found in snapshot\n`,
      );
    }
    const shard = audit.shardInvariant;
    if (shard && shard.evaluable && !shard.held) {
      process.stderr.write(
        `[audit ${recipe}]   !! shard-placement invariant violated: ${shard.wrongShardReceipts.length} callback receipt(s) executed off the contract's home shard (contractShard=${shard.contractShard})\n`,
      );
      for (const v of shard.wrongShardReceipts) {
        process.stderr.write(
          `[audit ${recipe}]      ${v.event}: receipt ${v.receiptId.slice(0, 10)}… (executor=${v.executorId}) landed on shard ${v.observedShard ?? "unknown"}\n`,
        );
      }
    } else if (shard && !shard.evaluable && shard.contractShard === null) {
      process.stderr.write(
        `[audit ${recipe}]   !! shard-placement invariant inconclusive: no FunctionCall receipt to ${shard.contractId} found to anchor the home shard\n`,
      );
    }
    audits.push(audit);
  }
  return audits;
}
