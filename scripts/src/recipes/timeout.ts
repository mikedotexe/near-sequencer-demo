// Recipe 2 — Timeout: what happens when no one resumes.
//
// tx1: recipes.recipe_timeout_yield(name)
//   → creates a yielded callback on_timeout_resumed, stores the YieldId.
//   → returns. There is NO matching resume method.
//
// 200 blocks later (NEP-519's fixed timeout budget), the callback fires
// anyway, with PromiseError in place of the resume payload. The contract's
// `on_timeout_resumed` matches on the Err arm and emits
// `recipe_resolved_err`.
//
// The flow waits long enough for the timeout to fire, then records the
// yield-block height for the audit. The callback receipt was scheduled
// at yield time and lives in the yield tx's DAG; when the 200-block
// budget expires, the runtime delivers `PromiseError` to that
// already-scheduled receipt. So the audit finds `recipe_resolved_err`
// by scanning the captured yield tx's `receipts_outcome[]` — no
// block-scan needed.

import {
  ACCOUNTS,
  DEPOSIT_YOCTO_ZERO,
  GAS_YIELD_TGAS,
  MASTER_ACCOUNT_ID,
  TIMEOUT_RUN_TIMEOUT_MS,
} from "../config.js";
import { blockByHash, connectSender, txStatus } from "../rpc.js";
import { makeDirectSender, type DirectSender } from "../tx.js";
import { writeRawAndCapture } from "./common.js";
import type { RawTimeoutArtifact } from "./types.js";

// Poll the yield tx's receipt DAG until it executes on-chain, then fetch
// its block height. Returns null if the tx hasn't shown up after a minute.
async function resolveYieldBlockHeight(
  hash: string,
  signer: string,
): Promise<number | null> {
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    try {
      const tx = await txStatus(hash, signer);
      const block = await blockByHash(tx.transaction_outcome.block_hash);
      return block.header.height;
    } catch {
      await new Promise((r) => setTimeout(r, 2000));
    }
  }
  return null;
}

async function runOnce(sender: DirectSender, runIndex: number): Promise<RawTimeoutArtifact> {
  const ts = Date.now();
  const name = `r${runIndex.toString().padStart(2, "0")}-${ts}`;
  const started = new Date(ts).toISOString();

  const t0 = Date.now();
  const yieldTxHash = await sender.broadcastFunctionCall(
    ACCOUNTS.recipes,
    "recipe_timeout_yield",
    { name },
    BigInt(GAS_YIELD_TGAS * 1_000_000_000_000),
    BigInt(DEPOSIT_YOCTO_ZERO),
  );
  process.stderr.write(`[run timeout]   yield: broadcast in ${Date.now() - t0}ms tx=${yieldTxHash.slice(0, 8)}\n`);

  const yieldBlockHeight = await resolveYieldBlockHeight(yieldTxHash, sender.accountId);
  process.stderr.write(
    `[run timeout]   yield executed at block ${yieldBlockHeight ?? "?"}; waiting for timeout (~${Math.round(
      TIMEOUT_RUN_TIMEOUT_MS / 60_000,
    )} min)...\n`,
  );
  await new Promise((r) => setTimeout(r, TIMEOUT_RUN_TIMEOUT_MS));

  return {
    recipe: "timeout",
    runIndex,
    name,
    signer: sender.accountId,
    started,
    finished: new Date().toISOString(),
    yieldTxHash,
    yieldBlockHeight,
  };
}

export async function runTimeoutRepeated(repeat: number): Promise<RawTimeoutArtifact[]> {
  const near = await connectSender();
  const sender = await makeDirectSender(near, MASTER_ACCOUNT_ID);

  const out: RawTimeoutArtifact[] = [];
  for (let i = 1; i <= repeat; i++) {
    process.stderr.write(`[run timeout] run ${i}/${repeat}...\n`);
    const raw = await runOnce(sender, i);
    await writeRawAndCapture(raw, [{ role: "yield", hash: raw.yieldTxHash, signer: raw.signer }]);
    out.push(raw);
  }
  return out;
}
