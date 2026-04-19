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
import { writeComparativeReport } from "./comparative.js";
import { explainDag } from "./explain-dag.js";
import { translate, parseRunFilter } from "./translate.js";
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
      "  explain-dag <basic|timeout|chained|handoff> [run]  print trace-event placement by tx role for a snapshotted run",
      "  aggregate                            summarize per-recipe stats",
      "  report                               write artifacts/<network>/report.md",
      "  comparative                          write artifacts/comparative.md (needs both testnet + mainnet)",
      "  translate [<recipe>] [--run N|latest|all]",
      "                                       regenerate viz/data/recipe-*-live-NN.json from snapshotted runs",
      "  all                                  build + deploy + run each recipe + audit + aggregate + report + translate",
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

// Counts violations across all invariants. An "evaluable but failing"
// check counts as 1; inconclusive checks (no snapshot, no anchor) don't
// count — same logic for every invariant that has an `evaluable` flag.
interface InvariantCounts {
  dag: number;
  budget: number;
  atomicity: number;
  shard: number;
}

interface AuditLike {
  dagInvariantViolations: unknown[];
  budgetInvariant?: { held: boolean; evaluable: boolean };
  atomicityInvariant?: { held: boolean; evaluable: boolean };
  shardInvariant?: { held: boolean; evaluable: boolean };
}

function countViolations(audits: AuditLike[]): InvariantCounts {
  let dag = 0;
  let budget = 0;
  let atomicity = 0;
  let shard = 0;
  for (const a of audits) {
    dag += a.dagInvariantViolations.length;
    if (a.budgetInvariant && a.budgetInvariant.evaluable && !a.budgetInvariant.held) budget++;
    if (a.atomicityInvariant && a.atomicityInvariant.evaluable && !a.atomicityInvariant.held) {
      atomicity++;
    }
    if (a.shardInvariant && a.shardInvariant.evaluable && !a.shardInvariant.held) shard++;
  }
  return { dag, budget, atomicity, shard };
}

function invariantTotal(counts: InvariantCounts): number {
  return counts.dag + counts.budget + counts.atomicity + counts.shard;
}

async function cmdAudit(rest: string[]): Promise<void> {
  const recipe = parseRecipeName(rest[0]);
  const audits = await auditRecipe(recipe);
  const v = countViolations(audits);
  if (invariantTotal(v) > 0) {
    const parts: string[] = [];
    if (v.dag > 0) parts.push(`dag=${v.dag}`);
    if (v.budget > 0) parts.push(`budget=${v.budget}`);
    if (v.atomicity > 0) parts.push(`atomicity=${v.atomicity}`);
    if (v.shard > 0) parts.push(`shard=${v.shard}`);
    process.stderr.write(
      `[audit ${recipe}] !! invariant(s) violated across ${audits.length} runs (${parts.join(", ")}) — see per-run audit JSON and artifacts/<network>/report.md\n`,
    );
    process.exit(1);
  }
}

async function cmdAggregate(): Promise<void> {
  const summaries = summarizeAll();
  for (const s of summaries) {
    const dag = s.dagInvariant.held
      ? `dag=PASS(${s.dagInvariant.eventsInExpectedPlace}/${s.dagInvariant.eventsChecked})`
      : `dag=VIOLATED(${s.dagInvariant.runsWithViolations}/${s.dagInvariant.runsChecked} runs)`;
    if (s.recipe === "basic") {
      process.stderr.write(
        `[aggregate] ${s.recipe}: runs=${s.runCount} ok=${s.resolvedOkCount} yield→resume median=${s.blocksFromYieldToResume.median ?? "n/a"} ${dag}\n`,
      );
    } else if (s.recipe === "timeout") {
      const budget = s.budgetInvariant.held
        ? `budget=PASS(${s.budgetInvariant.runsInRange}/${s.budgetInvariant.runsChecked})`
        : `budget=VIOLATED(${s.budgetInvariant.runsOutOfRange}/${s.budgetInvariant.runsChecked})`;
      process.stderr.write(
        `[aggregate] ${s.recipe}: runs=${s.runCount} fired=${s.timeoutFiredCount} yield→callback median=${s.blocksFromYieldToCallback.median ?? "n/a"} ${dag} ${budget}\n`,
      );
    } else if (s.recipe === "chained") {
      process.stderr.write(
        `[aggregate] ${s.recipe}: runs=${s.runCount} ok=${s.resolvedOkCount} observed=${s.observedValues.join(",")} ${dag}\n`,
      );
    } else {
      // handoff
      const budget = s.budgetInvariant.runsChecked === 0
        ? "budget=n/a(no timeout runs)"
        : s.budgetInvariant.held
          ? `budget=PASS(${s.budgetInvariant.runsInRange}/${s.budgetInvariant.runsChecked})`
          : `budget=VIOLATED(${s.budgetInvariant.runsOutOfRange}/${s.budgetInvariant.runsChecked})`;
      const atomicity = s.atomicityInvariant.held
        ? `atomicity=PASS(${s.atomicityInvariant.runsAtomicallyHeld}/${s.atomicityInvariant.runsChecked})`
        : `atomicity=VIOLATED(${s.atomicityInvariant.violations.length}/${s.atomicityInvariant.runsChecked})`;
      process.stderr.write(
        `[aggregate] ${s.recipe}: runs=${s.runCount} (claim=${s.claimCount} timeout=${s.timeoutCount}) settled_ok=${s.settledOkCount} ` +
          `claim y→settle median=${s.claimYieldToSettle.median ?? "n/a"} timeout y→settle median=${s.timeoutYieldToSettle.median ?? "n/a"} ${dag} ${budget} ${atomicity}\n`,
      );
    }
  }
}

async function cmdReport(): Promise<void> {
  const path = writeReport();
  process.stderr.write(`[report] wrote ${path}\n`);
}

// Cross-network comparative report. Unlike the other subcommands this
// is not partitioned by NEAR_NETWORK — it reads both artifacts/testnet/
// and artifacts/mainnet/ and writes artifacts/comparative.md at the
// root. Errors loudly if either tree is incomplete.
async function cmdComparative(): Promise<void> {
  const path = writeComparativeReport();
  process.stderr.write(`[comparative] wrote ${path}\n`);
}

async function cmdTranslate(rest: string[]): Promise<void> {
  const recipeArg = rest.find((a, i) => !a.startsWith("--") && rest[i - 1] !== "--run");
  const recipes = recipeArg ? [parseRecipeName(recipeArg)] : undefined;
  const run = parseRunFilter(rest);
  const { generated } = translate({ recipes, run });
  process.stderr.write(`[translate] wrote ${generated.length} timeline file(s)\n`);
}

async function cmdAll(): Promise<void> {
  await cmdBuild();
  await cmdDeploy();
  await runBasicRepeated(3);
  await runTimeoutRepeated(1);
  await runChainedRepeated(3);
  await runHandoffRepeated("claim", 2);
  await runHandoffRepeated("timeout", 1);
  const totals: InvariantCounts = { dag: 0, budget: 0, atomicity: 0, shard: 0 };
  let totalRuns = 0;
  for (const recipe of ["basic", "timeout", "chained", "handoff"] as const) {
    const audits = await auditRecipe(recipe);
    const v = countViolations(audits);
    totals.dag += v.dag;
    totals.budget += v.budget;
    totals.atomicity += v.atomicity;
    totals.shard += v.shard;
    totalRuns += audits.length;
  }
  await cmdAggregate();
  await cmdReport();
  try {
    const { generated } = translate({ run: "all" });
    process.stderr.write(`[all] translated ${generated.length} timeline file(s)\n`);
  } catch (e) {
    process.stderr.write(`[all] translate failed: ${(e as Error).message}\n`);
    // Keep going so the report is still produced; re-throw at end.
    process.exitCode = 1;
  }
  if (invariantTotal(totals) > 0) {
    const parts: string[] = [];
    if (totals.dag > 0) parts.push(`dag=${totals.dag}`);
    if (totals.budget > 0) parts.push(`budget=${totals.budget}`);
    if (totals.atomicity > 0) parts.push(`atomicity=${totals.atomicity}`);
    if (totals.shard > 0) parts.push(`shard=${totals.shard}`);
    process.stderr.write(
      `[all] !! invariant(s) violated across ${totalRuns} runs (${parts.join(", ")}) — see artifacts/<network>/report.md\n`,
    );
    process.exit(1);
  }
}

async function cmdClean(rest: string[]): Promise<void> {
  const guardFlag = `--i-know-this-is-${NEAR_NETWORK}`;
  if (!rest.includes(guardFlag)) {
    throw new Error(
      `refusing to clean on ${NEAR_NETWORK} without ${guardFlag}. ` +
        `This will delete these accounts: ${Object.values(ACCOUNTS).join(", ")}`,
    );
  }
  // Chain-id guard: if RPC_SEND is misconfigured (e.g., set to mainnet
  // while NEAR_NETWORK=testnet) the guardFlag check above would still
  // accept `--i-know-this-is-testnet` but then cleanAll() would delete
  // accounts on the wrong chain. assertChainIdMatches throws if the
  // RPC's reported chain_id doesn't match the NEAR_NETWORK env var,
  // catching this before any destructive action.
  await assertChainIdMatches();
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
      case "comparative":
        await cmdComparative();
        break;
      case "report":
        await cmdReport();
        break;
      case "translate":
        await cmdTranslate(rest);
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
