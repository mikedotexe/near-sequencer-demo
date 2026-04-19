// Recipe 3 — Chained: resume triggers a downstream call with callback.
//
// tx1: recipes.recipe_chained_yield(name, counter_id)
//   → creates a yielded callback on_chained_resumed. Callback args carry
//     the counter account id so the handler can dispatch without looking
//     it up.
//
// tx2: recipes.recipe_chained_resume(name, delta)
//   → resumes with ChainedSignal{delta}.
//
// On resume, on_chained_resumed dispatches counter.increment() (or
// decrement if delta < 0) and chains on_counter_observed. That callback
// reads the target's return value via #[callback_result] and emits
// `recipe_callback_observed` with the new counter value, then
// `recipe_resolved_ok`.

import {
  ACCOUNTS,
  DEPOSIT_YOCTO_ZERO,
  GAS_RESUME_TGAS,
  GAS_YIELD_TGAS,
  MASTER_ACCOUNT_ID,
} from "../config.js";
import { connectSender, viewAtBlock } from "../rpc.js";
import { makeDirectSender, type DirectSender } from "../tx.js";
import { writeRawAndSnapshot } from "./common.js";
import type { RawChainedArtifact } from "./types.js";

const YIELD_TO_RESUME_DELAY_MS = 2000;

async function ensureCounterInitialized(): Promise<void> {
  // Verify counter is reachable and initialized. A non-initialized contract
  // returns an error for get_num; the recipes contract would then fail the
  // chained dispatch. Fail early with a clear message.
  try {
    await viewAtBlock<number>(ACCOUNTS.counter, "get_num", {}, "final");
  } catch (e) {
    throw new Error(
      `counter contract at ${ACCOUNTS.counter} not reachable: ${(e as Error).message}. ` +
        `Did you run scripts/demo.sh deploy?`,
    );
  }
}

async function runOnce(sender: DirectSender, runIndex: number, delta: number): Promise<RawChainedArtifact> {
  const ts = Date.now();
  const name = `r${runIndex.toString().padStart(2, "0")}-${ts}`;
  const started = new Date(ts).toISOString();

  const t0 = Date.now();
  const yieldTxHash = await sender.broadcastFunctionCall(
    ACCOUNTS.recipes,
    "recipe_chained_yield",
    { name, counter_id: ACCOUNTS.counter },
    BigInt(GAS_YIELD_TGAS * 1_000_000_000_000),
    BigInt(DEPOSIT_YOCTO_ZERO),
  );
  process.stderr.write(`[run chained]   yield: broadcast in ${Date.now() - t0}ms tx=${yieldTxHash.slice(0, 8)}\n`);

  await new Promise((r) => setTimeout(r, YIELD_TO_RESUME_DELAY_MS));

  const t1 = Date.now();
  const resumeTxHash = await sender.broadcastFunctionCall(
    ACCOUNTS.recipes,
    "recipe_chained_resume",
    { name, delta },
    BigInt(GAS_RESUME_TGAS * 1_000_000_000_000),
    BigInt(DEPOSIT_YOCTO_ZERO),
  );
  process.stderr.write(`[run chained]   resume: broadcast in ${Date.now() - t1}ms tx=${resumeTxHash.slice(0, 8)}\n`);

  return {
    recipe: "chained",
    runIndex,
    name,
    signer: sender.accountId,
    started,
    finished: new Date().toISOString(),
    counterId: ACCOUNTS.counter,
    delta,
    yieldTxHash,
    resumeTxHash,
  };
}

export async function runChainedRepeated(repeat: number): Promise<RawChainedArtifact[]> {
  await ensureCounterInitialized();

  const near = await connectSender();
  const sender = await makeDirectSender(near, MASTER_ACCOUNT_ID);

  // Alternate +1 and -1 so repeated runs don't drift the counter monotonically
  // (and so the audit gets both arms of the increment/decrement branch).
  const out: RawChainedArtifact[] = [];
  for (let i = 1; i <= repeat; i++) {
    process.stderr.write(`[run chained] run ${i}/${repeat}...\n`);
    const delta = i % 2 === 1 ? 1 : -1;
    const raw = await runOnce(sender, i, delta);
    await writeRawAndSnapshot(raw, [
      { role: "yield", hash: raw.yieldTxHash, signer: raw.signer },
      { role: "resume", hash: raw.resumeTxHash, signer: raw.signer },
    ]);
    out.push(raw);
  }
  return out;
}
