// Recipe 1 — Basic cross-tx yield + resume.
//
// tx1: recipes.recipe_basic_yield(name)
//   → creates a yielded callback on_basic_resumed, stores the YieldId
//     under the key "basic:<name>" in contract state.
//
// tx2: recipes.recipe_basic_resume(name, payload)
//   → looks up the YieldId, calls yield_id.resume(BasicSignal{payload}).
//     The callback fires, logs `recipe_resolved_ok` with `outcome`
//     equal to the payload.
//
// Between txs we pause briefly so the yield has executed on-chain
// before we issue resume; without this the resume can race and find
// no matching yield (the yielded callback isn't registered until the
// yield tx executes). 2 s is consistent with testnet's ~1 s blocks.

import {
  ACCOUNTS,
  DEPOSIT_YOCTO_ZERO,
  GAS_RESUME_TGAS,
  GAS_YIELD_TGAS,
  MASTER_ACCOUNT_ID,
} from "../config.js";
import { connectSender } from "../rpc.js";
import { makeDirectSender, type DirectSender } from "../tx.js";
import { writeRawAndSnapshot } from "./common.js";
import type { RawBasicArtifact } from "./types.js";

const YIELD_TO_RESUME_DELAY_MS = 2000;

async function runOnce(sender: DirectSender, runIndex: number): Promise<RawBasicArtifact> {
  const ts = Date.now();
  const name = `r${runIndex.toString().padStart(2, "0")}-${ts}`;
  const payload = `hello-${runIndex}`;
  const started = new Date(ts).toISOString();

  const t0 = Date.now();
  const yieldTxHash = await sender.broadcastFunctionCall(
    ACCOUNTS.recipes,
    "recipe_basic_yield",
    { name },
    BigInt(GAS_YIELD_TGAS * 1_000_000_000_000),
    BigInt(DEPOSIT_YOCTO_ZERO),
  );
  process.stderr.write(`[run basic]   yield: broadcast in ${Date.now() - t0}ms tx=${yieldTxHash.slice(0, 8)}\n`);

  await new Promise((r) => setTimeout(r, YIELD_TO_RESUME_DELAY_MS));

  const t1 = Date.now();
  const resumeTxHash = await sender.broadcastFunctionCall(
    ACCOUNTS.recipes,
    "recipe_basic_resume",
    { name, payload },
    BigInt(GAS_RESUME_TGAS * 1_000_000_000_000),
    BigInt(DEPOSIT_YOCTO_ZERO),
  );
  process.stderr.write(`[run basic]   resume: broadcast in ${Date.now() - t1}ms tx=${resumeTxHash.slice(0, 8)}\n`);

  return {
    recipe: "basic",
    runIndex,
    name,
    signer: sender.accountId,
    started,
    finished: new Date().toISOString(),
    yieldTxHash,
    resumeTxHash,
    resumePayload: payload,
  };
}

export async function runBasicRepeated(repeat: number): Promise<RawBasicArtifact[]> {
  const near = await connectSender();
  const sender = await makeDirectSender(near, MASTER_ACCOUNT_ID);

  const out: RawBasicArtifact[] = [];
  for (let i = 1; i <= repeat; i++) {
    process.stderr.write(`[run basic] run ${i}/${repeat}...\n`);
    const raw = await runOnce(sender, i);
    await writeRawAndSnapshot(raw, [
      { role: "yield", hash: raw.yieldTxHash, signer: raw.signer },
      { role: "resume", hash: raw.resumeTxHash, signer: raw.signer },
    ]);
    out.push(raw);
  }
  return out;
}
