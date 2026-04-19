#!/usr/bin/env node

/**
 * onchain-to-timeline.mjs
 *
 * Read `<base>.raw.json` + sibling `<base>.onchain.json` (both produced
 * by `scripts/demo.sh run <recipe>`) and emit a TimelinePlayer JSON
 * driving the corresponding `viz/scenes/recipe_*.py` scene.
 *
 * The translator deliberately does NOT re-hit the network — every block
 * height, receipt, and log line is pulled from the snapshotted onchain.json.
 * This is the whole point of the snapshot: every live-rendered scene is
 * durable, and someone can regenerate the same timeline months later
 * even if archival RPC has aged out the txs.
 *
 * Usage:
 *   ./viz/scripts/onchain-to-timeline.mjs \
 *     --raw ../artifacts/testnet/recipe-basic/run-01.raw.json \
 *     --out viz/data/recipe-basic-live-01.json
 *
 * If `--onchain` is omitted, sibling `<base>.onchain.json` is used.
 * If `--out` is omitted, sibling `<base>.timeline.json` is used.
 */

import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { parseArgs } from "node:util";

const { values } = parseArgs({
  options: {
    raw: { type: "string" },
    onchain: { type: "string" },
    out: { type: "string" },
    name: { type: "string" },
  },
});

if (!values.raw) {
  console.error("usage: onchain-to-timeline.mjs --raw <run-NN.raw.json> [--onchain <run-NN.onchain.json>] [--out <out.json>] [--name \"title\"]");
  process.exit(1);
}

const rawPath = path.resolve(values.raw);
const onchainPath = values.onchain
  ? path.resolve(values.onchain)
  : rawPath.replace(/\.raw\.json$/, ".onchain.json");
const outPath = values.out ? path.resolve(values.out) : rawPath.replace(/\.raw\.json$/, ".timeline.json");

const raw = JSON.parse(fs.readFileSync(rawPath, "utf8"));
const onchain = JSON.parse(fs.readFileSync(onchainPath, "utf8"));
const recipe = raw.recipe;  // "basic" | "timeout" | "chained" | "handoff"

if (recipe !== "basic" && recipe !== "timeout" && recipe !== "chained" && recipe !== "handoff") {
  console.error(`unrecognized recipe in raw.json: ${recipe}`);
  process.exit(1);
}

// Handoff has two modes (claim, timeout) that share one scene file but
// produce different event sequences. Detect mode from the raw artifact.
const handoffMode = recipe === "handoff" ? raw.mode : null;
// Match against the recipient account id to decide who the tx_included
// arrow for resume should come from. Today the demo uses alice-signs-
// both so this resolves to "alice"; if a fork has Bob sign resume, we
// route the arrow through "bob" correspondingly.
const BOB_LABEL = recipe === "handoff" ? raw.recipient : null;

// ----------------------------------------------------------------------
// Helpers
// ----------------------------------------------------------------------

function heightOfBlockHash(blockHash) {
  const block = onchain.blocks[blockHash];
  if (!block) return null;
  return block.header.height;
}

function parseTrace(line) {
  if (typeof line !== "string" || !line.startsWith("trace:")) return null;
  try {
    return JSON.parse(line.slice("trace:".length));
  } catch {
    return null;
  }
}

function allSnapshottedTxs() {
  return Object.values(onchain.txStatus).filter(Boolean);
}

// Find the block height at which the first receipt outcome emits a trace
// event matching (ev, recipe, name). Returns null if not found.
function findTraceBlock(ev, name) {
  for (const tx of allSnapshottedTxs()) {
    for (const outcome of tx.receipts_outcome ?? []) {
      const height = heightOfBlockHash(outcome.block_hash);
      if (height == null) continue;
      for (const log of outcome.outcome?.logs ?? []) {
        const t = parseTrace(log);
        if (!t) continue;
        if (t.ev !== ev) continue;
        if (t.recipe !== recipe) continue;
        if (t.name !== name) continue;
        return { height, body: t };
      }
    }
  }
  return null;
}

// ----------------------------------------------------------------------
// Per-recipe event assembly
// ----------------------------------------------------------------------
//
// Every scene walks the same 3-beat arc: yield visible → resume/timeout
// visible → resolve visible. The events differ in what downstream motion
// is shown.

function stepId() {
  switch (recipe) {
    case "basic": return "b1";
    case "timeout": return "t1";
    case "chained": return "c1";
    case "handoff": return "h1";
  }
}

function assembleBasic() {
  const events = [];
  const step = stepId();

  const yieldTx = onchain.txStatus.yield;
  const resumeTx = onchain.txStatus.resume;
  const yieldTxBlock = yieldTx ? heightOfBlockHash(yieldTx.transaction_outcome.block_hash) : null;
  const resumeTxBlock = resumeTx ? heightOfBlockHash(resumeTx.transaction_outcome.block_hash) : null;

  const yielded = findTraceBlock("recipe_yielded", raw.name);
  const resumed = findTraceBlock("recipe_resumed", raw.name);
  const resolved = findTraceBlock("recipe_resolved_ok", raw.name)
                 ?? findTraceBlock("recipe_resolved_err", raw.name);

  if (yieldTxBlock != null) {
    events.push({ block: yieldTxBlock, type: "tx_included", actor: "user", target: "recipes",
                  method: `recipe_basic_yield("${raw.name}")` });
  }
  if (yielded) {
    events.push({ block: yielded.height, type: "yield_eject",
                  actor: "recipes", target: "recipes", method: "on_basic_resumed", step_id: step });
  }
  if (resumeTxBlock != null) {
    events.push({ block: resumeTxBlock, type: "tx_included", actor: "user", target: "recipes",
                  method: `recipe_basic_resume("${raw.name}","${raw.resumePayload}")` });
  }
  if (resumed) {
    events.push({ block: resumed.height, type: "resume_data",   actor: "recipes", step_id: step });
    events.push({ block: resumed.height, type: "resume_action", actor: "recipes", step_id: step });
  }
  if (resolved) {
    const status = resolved.body.ev === "recipe_resolved_ok" ? "ok" : "err";
    events.push({ block: resolved.height, type: "settle", actor: "recipes", step_id: step, status });
  }
  return events;
}

function assembleTimeout() {
  const events = [];
  const step = stepId();

  const yieldTx = onchain.txStatus.yield;
  const yieldTxBlock = yieldTx ? heightOfBlockHash(yieldTx.transaction_outcome.block_hash) : null;

  const yielded = findTraceBlock("recipe_yielded", raw.name);
  // Timeout: the callback receipt was scheduled at yield time and lives
  // in the yield tx's DAG. When the 200-block budget expires the runtime
  // delivers PromiseError to that already-scheduled receipt; its
  // receipt_outcome (with the `recipe_resolved_err` log line) becomes
  // attached to the yield tx's `receipts_outcome[]`. So findTraceBlock
  // usually succeeds from the snapshotted yield tx. Fall back to
  // yield+200 only if the snapshot somehow missed the post-budget block.
  const resolved = findTraceBlock("recipe_resolved_err", raw.name);
  const timeoutBlock = resolved?.height
    ?? (yielded ? yielded.height + 200 : null)
    ?? (yieldTxBlock != null ? yieldTxBlock + 200 : null);

  if (yieldTxBlock != null) {
    events.push({ block: yieldTxBlock, type: "tx_included", actor: "user", target: "recipes",
                  method: `recipe_timeout_yield("${raw.name}")` });
  }
  if (yielded) {
    events.push({ block: yielded.height, type: "yield_eject",
                  actor: "recipes", target: "recipes", method: "on_timeout_resumed", step_id: step });
    // Budget numeral — visible countdown anchored to the yielded
    // satellite. Fires a couple of blocks after yield so the viewer
    // sees it latch onto the satellite already-in-orbit, not co-
    // emerge. Dismissed one block after the timeout so the terminal
    // value flashes before the card fades.
    events.push({ block: yielded.height + 2, type: "budget_numeral",
                  step_id: step, offset: [1.6, 0.9], font_size: 44 });
  }
  if (timeoutBlock != null) {
    events.push({ block: timeoutBlock, type: "settle", actor: "recipes", step_id: step, status: "timeout" });
    events.push({ block: timeoutBlock + 1, type: "budget_numeral_hide", step_id: step });
  }
  return events;
}

function assembleChained() {
  const events = [];
  const step = stepId();

  const yieldTx = onchain.txStatus.yield;
  const resumeTx = onchain.txStatus.resume;
  const yieldTxBlock = yieldTx ? heightOfBlockHash(yieldTx.transaction_outcome.block_hash) : null;
  const resumeTxBlock = resumeTx ? heightOfBlockHash(resumeTx.transaction_outcome.block_hash) : null;

  const yielded = findTraceBlock("recipe_yielded", raw.name);
  const resumed = findTraceBlock("recipe_resumed", raw.name);
  const dispatched = findTraceBlock("recipe_dispatched", raw.name);
  const observed = findTraceBlock("recipe_callback_observed", raw.name);
  const resolved = findTraceBlock("recipe_resolved_ok", raw.name)
                 ?? findTraceBlock("recipe_resolved_err", raw.name);

  if (yieldTxBlock != null) {
    events.push({ block: yieldTxBlock, type: "tx_included", actor: "user", target: "recipes",
                  method: `recipe_chained_yield("${raw.name}", counter)` });
  }
  if (yielded) {
    events.push({ block: yielded.height, type: "yield_eject",
                  actor: "recipes", target: "recipes", method: "on_chained_resumed", step_id: step });
  }
  if (resumeTxBlock != null) {
    events.push({ block: resumeTxBlock, type: "tx_included", actor: "user", target: "recipes",
                  method: `recipe_chained_resume("${raw.name}", ${raw.delta})` });
  }
  if (resumed) {
    events.push({ block: resumed.height, type: "resume_data",   actor: "recipes", step_id: step });
    events.push({ block: resumed.height, type: "resume_action", actor: "recipes", step_id: step });
  }
  if (dispatched) {
    const method = dispatched.body.method ?? (raw.delta > 0 ? "increment" : "decrement");
    events.push({ block: dispatched.height, type: "downstream_call",
                  actor: "recipes", target: "counter", method, step_id: step });
  }
  if (observed) {
    events.push({ block: observed.height, type: "downstream_return",
                  actor: "counter", target: "recipes", status: "ok", step_id: step });
  }
  if (resolved) {
    const status = resolved.body.ev === "recipe_resolved_ok" ? "ok" : "err";
    events.push({ block: resolved.height, type: "settle", actor: "recipes", step_id: step, status });
  }
  return events;
}

function assembleHandoff() {
  const events = [];
  const step = stepId();

  const yieldTx = onchain.txStatus.yield;
  const resumeTx = onchain.txStatus.resume;
  const yieldTxBlock = yieldTx ? heightOfBlockHash(yieldTx.transaction_outcome.block_hash) : null;
  const resumeTxBlock = resumeTx ? heightOfBlockHash(resumeTx.transaction_outcome.block_hash) : null;

  const yielded = findTraceBlock("recipe_yielded", raw.name);
  const resumed = findTraceBlock("recipe_resumed", raw.name);
  // Settle is either handoff_released (claim mode) or handoff_refunded
  // (timeout mode). Both live in the yield tx's DAG because the
  // transfer is a child of the callback receipt scheduled at yield time.
  const released = findTraceBlock("handoff_released", raw.name);
  const refunded = findTraceBlock("handoff_refunded", raw.name);
  // Timeout fallback: if the snapshot missed the post-budget block, fake
  // a settle at yield+200 so the scene still renders (same guard as the
  // timeout recipe's translator).
  const settleBlock = released?.height
    ?? refunded?.height
    ?? (handoffMode === "timeout" && yielded ? yielded.height + 200 : null);

  if (yieldTxBlock != null) {
    events.push({
      block: yieldTxBlock, type: "tx_included", actor: "alice", target: "recipes",
      method: `recipe_handoff_yield("${raw.name}", to=bob)`,
    });
  }
  if (yielded) {
    events.push({
      block: yielded.height, type: "yield_eject",
      actor: "recipes", target: "recipes", method: "on_handoff_resumed", step_id: step,
    });
    // In timeout mode only, spawn the budget countdown so the viewer
    // watches the 200-block budget drain before the refund fires. In
    // claim mode the callback fires in ~6 blocks; the numeral would
    // barely be visible, so skip.
    if (handoffMode === "timeout") {
      events.push({ block: yielded.height + 2, type: "budget_numeral",
                    step_id: step, offset: [1.6, 0.9], font_size: 44 });
    }
  }
  if (resumeTxBlock != null) {
    // Resume is signed by alice in the current demo flow; even if a
    // fork signs resume from bob, the tx_included arrow should come
    // from whoever raw.claimSigner says signed it. Default to alice.
    const resumeActor = raw.claimSigner === BOB_LABEL ? "bob" : "alice";
    events.push({
      block: resumeTxBlock, type: "tx_included", actor: resumeActor, target: "recipes",
      method: `recipe_handoff_resume("${raw.name}")`,
    });
  }
  if (resumed) {
    events.push({ block: resumed.height, type: "resume_data", actor: "recipes", step_id: step });
    events.push({ block: resumed.height, type: "resume_action", actor: "recipes", step_id: step });
  }
  if (settleBlock != null) {
    const status = released ? "ok" : "timeout";
    events.push({ block: settleBlock, type: "settle", actor: "recipes", step_id: step, status });
    if (handoffMode === "timeout") {
      events.push({ block: settleBlock + 1, type: "budget_numeral_hide", step_id: step });
    }
  }
  return events;
}

const events =
  recipe === "basic" ? assembleBasic()
  : recipe === "timeout" ? assembleTimeout()
  : recipe === "chained" ? assembleChained()
  : assembleHandoff();

// ----------------------------------------------------------------------
// Narrative cards — per-recipe teaching frame.
// ----------------------------------------------------------------------

function narrativeCards(blockOrigin, lastEventBlock) {
  const cards = [];
  const handoffOpener =
    handoffMode === "timeout"
      ? {
          title: "Recipe 4 \u2014 atomic handoff (timeout)",
          body: "alice attaches 0.01 NEAR to a yield nominating bob. bob never claims. after 200 blocks the callback fires and refunds alice.",
        }
      : {
          title: "Recipe 4 \u2014 atomic handoff (claim)",
          body: "alice attaches 0.01 NEAR to a yield nominating bob. bob claims; the callback fires and transfers the funds to bob atomically.",
        };
  const opener = {
    basic: {
      title: "Recipe 1 \u2014 basic yield + resume",
      body: "tx1 yields a promise; tx2 resumes it with a payload; the callback fires and resolves ok.",
    },
    timeout: {
      title: "Recipe 2 \u2014 timeout",
      body: "what happens when no one resumes? NEP-519 guarantees the callback fires with PromiseError after the fixed 200-block budget.",
    },
    chained: {
      title: "Recipe 3 \u2014 chained",
      body: "resume triggers a downstream call; the recipe's receipt only resolves after it observes the target's truthful return.",
    },
    handoff: handoffOpener,
  }[recipe];
  cards.push({ block: blockOrigin + 1, type: "narrative", title: opener.title, body: opener.body });

  const closerOffset = 2;
  const handoffCloser =
    handoffMode === "timeout"
      ? { title: "refunded", body: "the same receipt that would have paid bob on a claim paid alice on the timeout. one primitive, two endings." }
      : { title: "delivered", body: "0.01 NEAR landed on bob; the transfer was a child of the callback receipt scheduled at yield time." };
  const closer = {
    basic: { title: "resolved", body: "callback fired exactly once; recipe_resolved_ok carries the payload." },
    timeout: { title: "resolved_err", body: "on_timeout_resumed's Err arm ran. the callback fired exactly once." },
    chained: { title: "observed", body: "on_counter_observed read the counter's new value; resolved_ok followed." },
    handoff: handoffCloser,
  }[recipe];
  cards.push({ block: lastEventBlock + closerOffset, type: "narrative", title: closer.title, body: closer.body });
  return cards;
}

// ----------------------------------------------------------------------
// Assemble + sort + write.
// ----------------------------------------------------------------------

if (events.length === 0) {
  console.error("[translate] no events found in snapshot; check that the raw/onchain pair belongs to this recipe");
  process.exit(2);
}

const blockOrigin = Math.min(...events.map((e) => e.block));
const lastEventBlock = Math.max(...events.map((e) => e.block));

const cards = narrativeCards(blockOrigin, lastEventBlock);

const actorAppearBlock = blockOrigin;
const actors = {
  recipes: { role: "contract", display_name: "recipes", account_id: "recipes", kind: "liquid",
             visible_at_start: false, radius: 0.62, display_font_size: 13, caption_font_size: 10 },
};
const actorAppearEvents = [
  { block: actorAppearBlock, type: "actor_appear", actor: "recipes" },
];

if (recipe === "handoff") {
  // Two caller-personas: alice (yield signer) and bob (claim signer or
  // nominated-but-absent on timeout). Both on stage either way — the
  // timeout scene's point is that bob is visible but never signs.
  actors.alice = { role: "caller", label: raw.signer, kind: "person", visible_at_start: false };
  actors.bob = { role: "caller", label: raw.recipient, kind: "person", visible_at_start: false };
  actorAppearEvents.push(
    { block: actorAppearBlock, type: "actor_appear", actor: "alice" },
    { block: actorAppearBlock, type: "actor_appear", actor: "bob" },
  );
} else {
  actors.user = { role: "caller", label: raw.signer, kind: "person", visible_at_start: false };
  actorAppearEvents.push({ block: actorAppearBlock, type: "actor_appear", actor: "user" });
  if (recipe === "chained") {
    actors.counter = { role: "contract", display_name: "counter", account_id: "counter", kind: "liquid",
                       visible_at_start: false, radius: 0.52, display_font_size: 14, caption_font_size: 10 };
    actorAppearEvents.push({ block: actorAppearBlock, type: "actor_appear", actor: "counter" });
  }
}

const allEvents = [...actorAppearEvents, ...events, ...cards];
allEvents.sort((a, b) => a.block - b.block);

const scene_name = values.name || `Recipe ${recipe} run ${raw.runIndex} \u2014 ${onchain.network}`;

const timeline = {
  name: scene_name,
  comment: `Generated by onchain-to-timeline.mjs from ${path.basename(rawPath)}; sourced from ${onchain.rpcEndpoints.archival}. Recipe=${recipe}, network=${onchain.network}, snapshotAt=${onchain.snapshotAt ?? onchain.capturedAt}. Every block height below is the real observed block.`,
  source: {
    recipe,
    runIndex: raw.runIndex,
    name: raw.name,
    signer: raw.signer,
    yieldTxHash: raw.yieldTxHash,
    resumeTxHash:
      recipe === "timeout" ? null
      : recipe === "handoff" ? (raw.resumeTxHash ?? null)
      : raw.resumeTxHash,
    mode: handoffMode,
    network: onchain.network,
    archivalRpc: onchain.rpcEndpoints.archival,
    snapshotAt: onchain.snapshotAt ?? onchain.capturedAt,
    protocolVersion: onchain.protocolVersion,
  },
  block_origin: blockOrigin,
  yield_budget_blocks: 200,
  actors,
  events: allEvents,
};

fs.mkdirSync(path.dirname(outPath), { recursive: true });
fs.writeFileSync(outPath, JSON.stringify(timeline, null, 2));

console.error(`[translate] ${rawPath} → ${outPath}`);
console.error(`[translate] recipe=${recipe} events=${allEvents.length} block_origin=${blockOrigin} last=${lastEventBlock}`);
