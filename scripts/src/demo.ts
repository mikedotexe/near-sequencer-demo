import { spawnSync } from "node:child_process";
import { mkdirSync } from "node:fs";

import {
  ACCOUNTS,
  ARTIFACTS_DIR,
  EXPECTED_CHAIN_ID,
  MASTER_ACCOUNT_ID,
  NEAR_NETWORK,
  REPO_ROOT,
  RPC_AUDIT,
  RPC_SEND,
} from "./config.js";
import { assertMasterCredentialPresent, cleanAll, deployAll } from "./accounts.js";
import { runBasicRepeated } from "./recipes/basic.js";
import { runTimeoutRepeated } from "./recipes/timeout.js";
import { runChainedRepeated } from "./recipes/chained.js";
import { runHandoffRepeated, type HandoffMode } from "./recipes/handoff.js";
import { auditRecipe } from "./audit.js";
import { summarizeAll } from "./aggregate.js";
import { writeReport } from "./report.js";
import { explainDag } from "./explain-dag.js";
import { assertChainIdMatches, connectSender, fetchStatus } from "./rpc.js";
import { parseRecipeName, type RecipeName } from "./recipes/types.js";

function usage(): void {
  process.stderr.write(
    [
      "usage: demo.sh <subcommand> [args]",
      "",
      "environment:",
      "  NEAR_NETWORK=testnet|mainnet  (default: testnet; recipe book is testnet-only)",
      "",
      "subcommands:",
      "  build                                cargo build --release --target wasm32-unknown-unknown",
      "  check                                verify RPC chain_id + master credentials + master balance",
      "  deploy                               ensure accounts + deploy recipes + counter + init",
      "  run <basic|timeout|chained|handoff> [--repeat N] [--mode claim|timeout (handoff only)]",
      "                                       broadcast a recipe flow N times (default 1)",
      "  audit <basic|timeout|chained|handoff>  parse onchain.json + trace events into per-run audit.json",
      "  explain-dag <basic|timeout|chained|handoff> [run]  print trace-event placement by tx role for a captured run",
      "  aggregate                            summarize per-recipe stats",
      "  report                               write artifacts/<network>/report.md",
      "  all                                  build + deploy + run each recipe + audit + aggregate + report",
      "  clean [--i-know-this-is-<network>]   delete recipes + counter accounts and wipe artifacts/<network>/",
      "",
    ].join("\n"),
  );
}

function banner(): void {
  process.stderr.write(
    `[demo] network=${NEAR_NETWORK} master=${MASTER_ACCOUNT_ID} rpc_send=${RPC_SEND} rpc_audit=${RPC_AUDIT}\n`,
  );
}

function parseRepeat(args: string[], defaultRepeat: number): number {
  const idx = args.indexOf("--repeat");
  if (idx === -1) return defaultRepeat;
  const val = args[idx + 1];
  const n = Number(val);
  if (!Number.isFinite(n) || n < 1 || n > 100) throw new Error(`invalid --repeat value: ${val}`);
  return Math.floor(n);
}

function parseHandoffMode(args: string[]): HandoffMode {
  const idx = args.indexOf("--mode");
  if (idx === -1) return "claim";
  const val = args[idx + 1];
  if (val !== "claim" && val !== "timeout") {
    throw new Error(`invalid --mode value: ${val}. must be "claim" or "timeout"`);
  }
  return val;
}

async function cmdBuild(): Promise<void> {
  process.stderr.write("[build] cargo build --release --target wasm32-unknown-unknown\n");
  const result = spawnSync("cargo", ["build", "--release", "--target", "wasm32-unknown-unknown"], {
    cwd: REPO_ROOT,
    stdio: "inherit",
  });
  if (result.status !== 0) throw new Error(`cargo build failed (exit ${result.status})`);
}

async function cmdCheck(): Promise<void> {
  process.stderr.write(`[check] expecting chain_id="${EXPECTED_CHAIN_ID}"...\n`);
  const status = await fetchStatus(RPC_SEND);
  if (status.chain_id !== EXPECTED_CHAIN_ID) {
    throw new Error(
      `chain_id mismatch: RPC reports "${status.chain_id}", NEAR_NETWORK expects "${EXPECTED_CHAIN_ID}"`,
    );
  }
  process.stderr.write(
    `[check]   chain_id=${status.chain_id} protocol=${status.protocol_version ?? "?"} head=${
      status.sync_info?.latest_block_height ?? "?"
    }\n`,
  );

  assertMasterCredentialPresent();
  process.stderr.write(`[check]   credentials present for ${MASTER_ACCOUNT_ID}\n`);

  const near = await connectSender();
  const acct = await near.account(MASTER_ACCOUNT_ID);
  try {
    const state = await acct.state();
    const yocto = BigInt(state.amount);
    const near_amt = Number(yocto / 10n ** 21n) / 1000;
    process.stderr.write(`[check]   balance: ${near_amt} NEAR (${state.amount} yocto)\n`);
  } catch (e) {
    process.stderr.write(`[check]   balance: unknown (${(e as Error).message})\n`);
  }
  process.stderr.write(`[check] ok\n`);
}

async function cmdDeploy(): Promise<void> {
  await assertChainIdMatches();
  assertMasterCredentialPresent();
  if (NEAR_NETWORK === "mainnet") {
    process.stderr.write(`[deploy] MAINNET deploy to accounts:\n`);
    for (const [role, id] of Object.entries(ACCOUNTS)) process.stderr.write(`[deploy]   ${role} -> ${id}\n`);
    process.stderr.write(`[deploy] proceeding in 3s (Ctrl-C to abort)...\n`);
    await new Promise((r) => setTimeout(r, 3000));
  }
  mkdirSync(ARTIFACTS_DIR, { recursive: true });
  await deployAll();
}

async function cmdRun(rest: string[]): Promise<void> {
  await assertChainIdMatches();
  assertMasterCredentialPresent();
  const recipe = parseRecipeName(rest[0]);
  const repeat = parseRepeat(rest, 1);
  mkdirSync(ARTIFACTS_DIR, { recursive: true });
  if (recipe === "handoff") {
    const mode = parseHandoffMode(rest);
    await runHandoffRepeated(mode, repeat);
    return;
  }
  await runByRecipe(recipe, repeat);
}

async function runByRecipe(recipe: RecipeName, repeat: number): Promise<void> {
  switch (recipe) {
    case "basic":
      await runBasicRepeated(repeat);
      break;
    case "timeout":
      await runTimeoutRepeated(repeat);
      break;
    case "chained":
      await runChainedRepeated(repeat);
      break;
    case "handoff":
      // Handled by cmdRun directly because it needs a mode parameter.
      // Unreachable here but required for exhaustive switch.
      await runHandoffRepeated("claim", repeat);
      break;
  }
}

async function cmdAudit(rest: string[]): Promise<void> {
  const recipe = parseRecipeName(rest[0]);
  await auditRecipe(recipe);
}

async function cmdAggregate(): Promise<void> {
  const summaries = summarizeAll();
  for (const s of summaries) {
    if (s.recipe === "basic") {
      process.stderr.write(
        `[aggregate] ${s.recipe}: runs=${s.runCount} ok=${s.resolvedOkCount} yield→resume median=${s.blocksFromYieldToResume.median ?? "n/a"}\n`,
      );
    } else if (s.recipe === "timeout") {
      process.stderr.write(
        `[aggregate] ${s.recipe}: runs=${s.runCount} fired=${s.timeoutFiredCount} yield→callback median=${s.blocksFromYieldToCallback.median ?? "n/a"}\n`,
      );
    } else if (s.recipe === "chained") {
      process.stderr.write(
        `[aggregate] ${s.recipe}: runs=${s.runCount} ok=${s.resolvedOkCount} observed=${s.observedValues.join(",")}\n`,
      );
    } else {
      // handoff
      process.stderr.write(
        `[aggregate] ${s.recipe}: runs=${s.runCount} (claim=${s.claimCount} timeout=${s.timeoutCount}) settled_ok=${s.settledOkCount} ` +
          `claim y→settle median=${s.claimYieldToSettle.median ?? "n/a"} timeout y→settle median=${s.timeoutYieldToSettle.median ?? "n/a"}\n`,
      );
    }
  }
}

async function cmdReport(): Promise<void> {
  const path = writeReport();
  process.stderr.write(`[report] wrote ${path}\n`);
}

async function cmdAll(): Promise<void> {
  await cmdBuild();
  await cmdDeploy();
  await runBasicRepeated(3);
  await runTimeoutRepeated(1);
  await runChainedRepeated(3);
  await runHandoffRepeated("claim", 2);
  await runHandoffRepeated("timeout", 1);
  for (const recipe of ["basic", "timeout", "chained", "handoff"] as const) {
    await auditRecipe(recipe);
  }
  await cmdAggregate();
  await cmdReport();
}

async function cmdClean(rest: string[]): Promise<void> {
  const guardFlag = `--i-know-this-is-${NEAR_NETWORK}`;
  if (!rest.includes(guardFlag)) {
    throw new Error(
      `refusing to clean on ${NEAR_NETWORK} without ${guardFlag}. ` +
        `This will delete these accounts: ${Object.values(ACCOUNTS).join(", ")}`,
    );
  }
  await cleanAll();
  const rm = spawnSync("rm", ["-rf", ARTIFACTS_DIR], { stdio: "inherit" });
  if (rm.status !== 0) process.stderr.write(`[clean] rm ${ARTIFACTS_DIR}: exit ${rm.status}\n`);
}

async function main(): Promise<void> {
  const [, , cmd, ...rest] = process.argv;
  banner();
  try {
    switch (cmd) {
      case "build":
        await cmdBuild();
        break;
      case "check":
        await cmdCheck();
        break;
      case "deploy":
        await cmdDeploy();
        break;
      case "run":
        await cmdRun(rest);
        break;
      case "audit":
        await cmdAudit(rest);
        break;
      case "explain-dag":
        explainDag(rest[0], rest[1]);
        break;
      case "aggregate":
        await cmdAggregate();
        break;
      case "report":
        await cmdReport();
        break;
      case "all":
        await cmdAll();
        break;
      case "clean":
        await cmdClean(rest);
        break;
      default:
        usage();
        process.exit(cmd ? 2 : 0);
    }
  } catch (e) {
    process.stderr.write(`[demo] ERROR: ${(e as Error).message}\n`);
    process.exit(1);
  }
}

await main();
