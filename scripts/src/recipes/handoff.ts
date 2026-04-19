// Recipe 4 — Atomic handoff.
//
// tx1 (Alice): recipes.recipe_handoff_yield(name, to=bob), attaching
//   `amount_yocto` NEAR. The contract receives the deposit, schedules
//   a callback (args: from, to, amount), and stores (yield_id, to).
//
// Claim mode:
//   tx2 (also Alice, permissionlessly): recipes.recipe_handoff_resume(name).
//   Callback's Ok arm runs `Promise::new(to).transfer(amount)` — Bob
//   receives the funds. The nominated recipient was fixed at yield
//   time; the resumer only pulls the trigger.
//
// Timeout mode:
//   No tx2. ~200 blocks later, the runtime delivers `PromiseError` to
//   the already-scheduled callback; the Err arm runs
//   `Promise::new(from).transfer(amount)` and Alice is refunded.
//
// Both endings are carried by the single receipt scheduled at yield
// time. No escrow table, no refund method, no polling. The "primitive
// did the thing" demo.
//
// On resume signer: Alice signs both txs in this flow rather than Bob.
// We originally had Bob sign the resume to demonstrate access control,
// but testnet's tx ordering between two independent signers sometimes
// races (Bob's tx can land with stale state and panic "no handoff
// found"). Keeping Alice as the single signer preserves the economic
// demo (value actually moves to Bob) and sidesteps the race; access
// control is a recipe-book footnote, not the main claim.

import {
  ACCOUNTS,
  BOB_ACCOUNT_ID,
  DEPOSIT_YOCTO_ZERO,
  GAS_RESUME_TGAS,
  GAS_YIELD_TGAS,
  HANDOFF_AMOUNT_YOCTO,
  HANDOFF_TIMEOUT_RUN_TIMEOUT_MS,
  MASTER_ACCOUNT_ID,
} from "../config.js";
import { blockByHash, connectSender, txStatus } from "../rpc.js";
import { makeDirectSender, type DirectSender } from "../tx.js";
import { writeRawAndSnapshot } from "./common.js";
import type { RawHandoffArtifact } from "./types.js";

export type HandoffMode = "claim" | "timeout";

const YIELD_TO_RESUME_DELAY_MS = 2000;

async function resolveYieldBlockHeight(hash: string, signer: string): Promise<number | null> {
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    try {
      // INCLUDED returns as soon as the tx is in a block — we don't need
      // FINAL (which, for yielded txs, can wait up to 200 blocks for the
      // yielded callback to finalize).
      const tx = await txStatus(hash, signer, "INCLUDED");
      const block = await blockByHash(tx.transaction_outcome.block_hash);
      return block.header.height;
    } catch {
      await new Promise((r) => setTimeout(r, 2000));
    }
  }
  return null;
}

async function runOnce(
  alice: DirectSender,
  mode: HandoffMode,
  runIndex: number,
): Promise<RawHandoffArtifact> {
  const ts = Date.now();
  const name = `r${runIndex.toString().padStart(2, "0")}-${mode}-${ts}`;
  const started = new Date(ts).toISOString();

  const t0 = Date.now();
  const yieldTxHash = await alice.broadcastFunctionCall(
    ACCOUNTS.recipes,
    "recipe_handoff_yield",
    { name, to: BOB_ACCOUNT_ID },
    BigInt(GAS_YIELD_TGAS * 1_000_000_000_000),
    BigInt(HANDOFF_AMOUNT_YOCTO),
  );
  process.stderr.write(
    `[run handoff]   yield(alice → contract, ${HANDOFF_AMOUNT_YOCTO} yocto to=${BOB_ACCOUNT_ID}): ` +
      `broadcast in ${Date.now() - t0}ms tx=${yieldTxHash.slice(0, 8)}\n`,
  );

  const yieldBlockHeight = await resolveYieldBlockHeight(yieldTxHash, alice.accountId);
  process.stderr.write(
    `[run handoff]   yield executed at block ${yieldBlockHeight ?? "?"}\n`,
  );

  let resumeTxHash: string | null = null;
  // claimSigner is always Alice in this flow; recorded for schema
  // consistency with the raw artifact (translator uses it to label
  // the resume-tx origin in the viz).
  let claimSigner: string | null = null;

  if (mode === "claim") {
    await new Promise((r) => setTimeout(r, YIELD_TO_RESUME_DELAY_MS));

    const t1 = Date.now();
    resumeTxHash = await alice.broadcastFunctionCall(
      ACCOUNTS.recipes,
      "recipe_handoff_resume",
      { name },
      BigInt(GAS_RESUME_TGAS * 1_000_000_000_000),
      BigInt(DEPOSIT_YOCTO_ZERO),
    );
    claimSigner = alice.accountId;
    process.stderr.write(
      `[run handoff]   resume(alice → contract, triggers transfer to bob): ` +
        `broadcast in ${Date.now() - t1}ms tx=${resumeTxHash.slice(0, 8)}\n`,
    );
  } else {
    process.stderr.write(
      `[run handoff]   mode=timeout; waiting for timeout ` +
        `(~${Math.round(HANDOFF_TIMEOUT_RUN_TIMEOUT_MS / 60_000)} min)...\n`,
    );
    await new Promise((r) => setTimeout(r, HANDOFF_TIMEOUT_RUN_TIMEOUT_MS));
  }

  return {
    recipe: "handoff",
    runIndex,
    mode,
    name,
    signer: alice.accountId,
    recipient: BOB_ACCOUNT_ID,
    amountYocto: HANDOFF_AMOUNT_YOCTO,
    started,
    finished: new Date().toISOString(),
    yieldTxHash,
    yieldBlockHeight,
    resumeTxHash,
    claimSigner,
  };
}

export async function runHandoffRepeated(
  mode: HandoffMode,
  repeat: number,
): Promise<RawHandoffArtifact[]> {
  const near = await connectSender();
  const alice = await makeDirectSender(near, MASTER_ACCOUNT_ID);

  const out: RawHandoffArtifact[] = [];
  for (let i = 1; i <= repeat; i++) {
    process.stderr.write(`[run handoff] run ${i}/${repeat} (mode=${mode})...\n`);
    const raw = await runOnce(alice, mode, i);
    const hashes: Array<{ role: string; hash: string; signer: string }> = [
      { role: "yield", hash: raw.yieldTxHash, signer: raw.signer },
    ];
    if (raw.resumeTxHash && raw.claimSigner) {
      hashes.push({ role: "resume", hash: raw.resumeTxHash, signer: raw.claimSigner });
    }
    const modeSuffix = `${mode}-${i.toString().padStart(2, "0")}`;
    await writeRawAndSnapshot(raw, hashes, modeSuffix);
    out.push(raw);
  }
  return out;
}
