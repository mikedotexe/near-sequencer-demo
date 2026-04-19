// Unit tests for invariant aggregation.
//
// The functions under test are pure data transforms: per-run check
// (checkBudget) and per-recipe roll-ups (computeDagInvariant,
// computeBudgetInvariant, computeAtomicityInvariant). They sit between
// the raw audit artifacts and the report renderer, so a subtle bug
// (e.g. `held` never flipping, `runsChecked` always zero) could pass
// CI's grep on the committed report but still produce a silently wrong
// rendering contract for future runs. Unit tests pin the contract
// here.
//
// The receipt-walking functions (checkAtomicity, computeDagPlacement)
// are intentionally NOT unit-tested — they'd require synthesizing a
// full SnapshotSource with fake receipts + chunks. Instead they're
// integration-tested by `./scripts/demo.sh audit <recipe>` against the
// committed `onchain.json` artifacts, which is the more meaningful
// check for DAG-walking logic.
//
// Run: `npm test` (from scripts/). No framework — self-rolled harness
// keeps the test surface minimal and stable across tsx/node versions.

import { strict as assert } from "node:assert";

import {
  BUDGET_LOWER_BLOCKS,
  BUDGET_UPPER_BLOCKS,
  checkBudget,
  type Audit,
  type BasicAudit,
  type BudgetInvariantResult,
  type HandoffAudit,
  type ShardInvariantResult,
  type TimeoutAudit,
} from "../src/audit.js";
import {
  computeAtomicityInvariant,
  computeBudgetInvariant,
  computeDagInvariant,
  computeShardInvariant,
  type BudgetInputRun,
  type ShardInputRun,
} from "../src/aggregate.js";

// ---------------------------------------------------------------------------
// Tiny harness
// ---------------------------------------------------------------------------

let passed = 0;
let failed = 0;
const failures: string[] = [];

function test(name: string, fn: () => void): void {
  try {
    fn();
    passed++;
    process.stdout.write(`  \u2713 ${name}\n`);
  } catch (e) {
    failed++;
    const msg = e instanceof Error ? e.message : String(e);
    failures.push(`${name}: ${msg}`);
    process.stdout.write(`  \u2717 ${name}\n`);
    process.stdout.write(`    ${msg.split("\n").join("\n    ")}\n`);
  }
}

function group(name: string, body: () => void): void {
  process.stdout.write(`\n${name}\n`);
  body();
}

// ---------------------------------------------------------------------------
// Fixture helpers
// ---------------------------------------------------------------------------

// Construct a minimal BasicAudit with just enough fields to exercise
// the aggregation path. Fields irrelevant to computeDagInvariant use
// zero-ish defaults; DAG placement / violations are the interesting part.
function mkBasicAudit(
  runIndex: number,
  placement: Record<string, "yield" | "resume" | null>,
  violations: Array<{ event: string; expected: "yield" | "resume"; actual: "yield" | "resume" | null }>,
): BasicAudit {
  return {
    recipe: "basic",
    runIndex,
    name: `fixture-${runIndex}`,
    signer: "test.testnet",
    auditSource: "onchain_json",
    yieldTxHash: "yh",
    yieldBlockHeight: 1000,
    resumeTxHash: "rh",
    resumeBlockHeight: 1004,
    callbackBlockHeight: 1006,
    resolvedOk: true,
    resolvedPayload: "p",
    blocksFromYieldToResume: 4,
    blocksFromResumeToCallback: 2,
    explorerUrl: "u",
    interpretation: "ok",
    dagPlacement: placement,
    dagInvariantViolations: violations,
  };
}

function mkHandoffAudit(
  runIndex: number,
  mode: "claim" | "timeout",
  atomicityHeld: boolean,
  atomicityEvaluable: boolean,
  expectedRecipient: string,
  expectedAmountYocto: string,
  observed: {
    receiptId: string;
    receiverId: string;
    depositYocto: string;
    succeeded: boolean;
  } | null,
  budget?: BudgetInvariantResult,
): HandoffAudit {
  return {
    recipe: "handoff",
    mode,
    runIndex,
    name: `fixture-${mode}-${runIndex}`,
    signer: "alice.testnet",
    auditSource: "onchain_json",
    recipient: expectedRecipient,
    amountYocto: expectedAmountYocto,
    yieldTxHash: "yh",
    yieldBlockHeight: 1000,
    resumeTxHash: mode === "claim" ? "rh" : null,
    claimSigner: mode === "claim" ? "alice.testnet" : null,
    resumeBlockHeight: mode === "claim" ? 1007 : null,
    settleBlockHeight: mode === "claim" ? 1009 : 1202,
    fundsRecipient: expectedRecipient,
    settledOk: mode === "claim",
    blocksFromYieldToResume: mode === "claim" ? 7 : null,
    blocksFromYieldToSettle: mode === "claim" ? 9 : 202,
    explorerUrl: "u",
    interpretation: "ok",
    dagPlacement: {},
    dagInvariantViolations: [],
    atomicityInvariant: {
      held: atomicityHeld,
      evaluable: atomicityEvaluable,
      mode,
      expectedRecipient,
      expectedAmountYocto,
      observed,
    },
    ...(budget ? { budgetInvariant: budget } : {}),
  };
}

// ---------------------------------------------------------------------------
// checkBudget
// ---------------------------------------------------------------------------

group("checkBudget (per-run NEP-519 200-block check)", () => {
  test("exact lower bound is PASS", () => {
    const r = checkBudget(BUDGET_LOWER_BLOCKS);
    assert.equal(r.held, true);
    assert.equal(r.evaluable, true);
    assert.equal(r.observedBlocks, BUDGET_LOWER_BLOCKS);
    assert.equal(r.lowerBound, BUDGET_LOWER_BLOCKS);
    assert.equal(r.upperBound, BUDGET_UPPER_BLOCKS);
  });

  test("observed corpus value (202) is PASS", () => {
    assert.equal(checkBudget(202).held, true);
  });

  test("exact upper bound is PASS", () => {
    assert.equal(checkBudget(BUDGET_UPPER_BLOCKS).held, true);
  });

  test("one above upper bound is FAIL", () => {
    const r = checkBudget(BUDGET_UPPER_BLOCKS + 1);
    assert.equal(r.held, false);
    assert.equal(r.evaluable, true);
  });

  test("one below lower bound is FAIL", () => {
    const r = checkBudget(BUDGET_LOWER_BLOCKS - 1);
    assert.equal(r.held, false);
    assert.equal(r.evaluable, true);
  });

  test("null is inconclusive (held true, evaluable false)", () => {
    // Null means the callback receipt wasn't located in the snapshot.
    // We treat as "can't tell" rather than "violated" so a partial
    // snapshot doesn't fire a false alarm.
    const r = checkBudget(null);
    assert.equal(r.held, true);
    assert.equal(r.evaluable, false);
    assert.equal(r.observedBlocks, null);
  });
});

// ---------------------------------------------------------------------------
// computeDagInvariant
// ---------------------------------------------------------------------------

group("computeDagInvariant (per-recipe DAG-placement roll-up)", () => {
  test("empty audits is vacuously held", () => {
    const r = computeDagInvariant([]);
    assert.equal(r.held, true);
    assert.equal(r.runsChecked, 0);
    assert.equal(r.runsWithViolations, 0);
    assert.equal(r.eventsChecked, 0);
    assert.equal(r.eventsInExpectedPlace, 0);
    assert.equal(r.violations.length, 0);
  });

  test("clean audits report held=true and full events-in-place count", () => {
    const audits: Audit[] = [
      mkBasicAudit(
        1,
        { recipe_yielded: "yield", recipe_resumed: "resume", recipe_resolved_ok: "yield" },
        [],
      ),
      mkBasicAudit(
        2,
        { recipe_yielded: "yield", recipe_resumed: "resume", recipe_resolved_ok: "yield" },
        [],
      ),
    ];
    const r = computeDagInvariant(audits);
    assert.equal(r.held, true);
    assert.equal(r.runsChecked, 2);
    assert.equal(r.runsWithViolations, 0);
    assert.equal(r.eventsChecked, 6); // 3 per run * 2 runs
    assert.equal(r.eventsInExpectedPlace, 6);
  });

  test("one audit with two violations flips held=false", () => {
    const audits: Audit[] = [
      mkBasicAudit(
        1,
        { recipe_yielded: "yield", recipe_resumed: "resume", recipe_resolved_ok: "yield" },
        [],
      ),
      mkBasicAudit(
        2,
        {
          recipe_yielded: "yield",
          recipe_resumed: "yield", // wrong — expected resume
          recipe_resolved_ok: "resume", // wrong — expected yield
        },
        [
          { event: "recipe_resumed", expected: "resume", actual: "yield" },
          { event: "recipe_resolved_ok", expected: "yield", actual: "resume" },
        ],
      ),
    ];
    const r = computeDagInvariant(audits);
    assert.equal(r.held, false);
    assert.equal(r.runsChecked, 2);
    assert.equal(r.runsWithViolations, 1);
    assert.equal(r.eventsChecked, 6);
    assert.equal(r.eventsInExpectedPlace, 4);
    assert.equal(r.violations.length, 2);
    assert.equal(r.violations[0]!.event, "recipe_resumed");
    assert.equal(r.violations[0]!.runIndex, 2);
  });

  test("handoff violations record mode in the violation row", () => {
    const audits: Audit[] = [
      mkHandoffAudit(
        1,
        "claim",
        true,
        true,
        "bob.testnet",
        "10000",
        { receiptId: "r", receiverId: "bob.testnet", depositYocto: "10000", succeeded: true },
      ),
    ];
    // Inject a DAG violation for this handoff audit (the placement +
    // violations fields are independent of the atomicity fields).
    audits[0]!.dagPlacement = {
      handoff_released: "resume", // wrong — expected yield
    };
    audits[0]!.dagInvariantViolations = [
      { event: "handoff_released", expected: "yield", actual: "resume" },
    ];
    const r = computeDagInvariant(audits);
    assert.equal(r.held, false);
    assert.equal(r.violations.length, 1);
    assert.equal(r.violations[0]!.mode, "claim");
    assert.equal(r.violations[0]!.event, "handoff_released");
  });
});

// ---------------------------------------------------------------------------
// computeBudgetInvariant
// ---------------------------------------------------------------------------

group("computeBudgetInvariant (per-recipe budget roll-up)", () => {
  test("no runs → held=true, all counts zero", () => {
    const r = computeBudgetInvariant([]);
    assert.equal(r.held, true);
    assert.equal(r.runsChecked, 0);
    assert.equal(r.runsInRange, 0);
    assert.equal(r.runsOutOfRange, 0);
    assert.equal(r.runsNotEvaluable, 0);
  });

  test("runs without budgetInvariant are skipped entirely", () => {
    const runs: BudgetInputRun[] = [
      { runIndex: 1 }, // no budgetInvariant (e.g. handoff claim mode)
      { runIndex: 2 },
    ];
    const r = computeBudgetInvariant(runs);
    assert.equal(r.runsChecked, 0);
  });

  test("all runs in range → held=true, runsInRange matches count", () => {
    const runs: BudgetInputRun[] = [
      { runIndex: 1, budgetInvariant: checkBudget(202) },
      { runIndex: 2, budgetInvariant: checkBudget(204) },
    ];
    const r = computeBudgetInvariant(runs);
    assert.equal(r.held, true);
    assert.equal(r.runsChecked, 2);
    assert.equal(r.runsInRange, 2);
    assert.equal(r.runsOutOfRange, 0);
    assert.deepEqual(r.observedBlocks, [202, 204]);
  });

  test("one out-of-range run flips held=false and records violation", () => {
    const runs: BudgetInputRun[] = [
      { runIndex: 1, budgetInvariant: checkBudget(202) },
      { runIndex: 2, budgetInvariant: checkBudget(210) }, // out of range
      { runIndex: 3, mode: "timeout", budgetInvariant: checkBudget(199) }, // out of range
    ];
    const r = computeBudgetInvariant(runs);
    assert.equal(r.held, false);
    assert.equal(r.runsInRange, 1);
    assert.equal(r.runsOutOfRange, 2);
    assert.equal(r.violations.length, 2);
    assert.equal(r.violations[0]!.runIndex, 2);
    assert.equal(r.violations[0]!.observedBlocks, 210);
    assert.equal(r.violations[1]!.mode, "timeout");
  });

  test("not-evaluable runs don't count toward runsChecked or violations", () => {
    const runs: BudgetInputRun[] = [
      { runIndex: 1, budgetInvariant: checkBudget(null) }, // snapshot missing
      { runIndex: 2, budgetInvariant: checkBudget(202) },
    ];
    const r = computeBudgetInvariant(runs);
    assert.equal(r.runsNotEvaluable, 1);
    assert.equal(r.runsChecked, 1);
    assert.equal(r.runsInRange, 1);
    assert.equal(r.held, true); // 1 evaluable run, in range
  });
});

// ---------------------------------------------------------------------------
// computeAtomicityInvariant
// ---------------------------------------------------------------------------

group("computeAtomicityInvariant (per-recipe atomicity roll-up)", () => {
  test("empty runs → held=false (nothing evaluated)", () => {
    const r = computeAtomicityInvariant([]);
    assert.equal(r.held, false); // defensive: "all 0 runs hold" is useless signal
    assert.equal(r.runsChecked, 0);
    assert.equal(r.runsAtomicallyHeld, 0);
  });

  test("all runs atomically held → held=true", () => {
    const runs = [
      mkHandoffAudit(1, "claim", true, true, "bob.testnet", "10000", {
        receiptId: "r1",
        receiverId: "bob.testnet",
        depositYocto: "10000",
        succeeded: true,
      }),
      mkHandoffAudit(2, "claim", true, true, "bob.testnet", "10000", {
        receiptId: "r2",
        receiverId: "bob.testnet",
        depositYocto: "10000",
        succeeded: true,
      }),
      mkHandoffAudit(1, "timeout", true, true, "alice.testnet", "10000", {
        receiptId: "r3",
        receiverId: "alice.testnet",
        depositYocto: "10000",
        succeeded: true,
      }),
    ];
    const r = computeAtomicityInvariant(runs);
    assert.equal(r.held, true);
    assert.equal(r.runsChecked, 3);
    assert.equal(r.runsAtomicallyHeld, 3);
    assert.equal(r.violations.length, 0);
  });

  test("one run with wrong receiver flips held=false", () => {
    const runs = [
      mkHandoffAudit(1, "claim", true, true, "bob.testnet", "10000", {
        receiptId: "r1",
        receiverId: "bob.testnet",
        depositYocto: "10000",
        succeeded: true,
      }),
      mkHandoffAudit(2, "claim", false, true, "bob.testnet", "10000", {
        receiptId: "r2",
        receiverId: "mallory.testnet", // wrong recipient
        depositYocto: "10000",
        succeeded: true,
      }),
    ];
    const r = computeAtomicityInvariant(runs);
    assert.equal(r.held, false);
    assert.equal(r.violations.length, 1);
    assert.equal(r.violations[0]!.runIndex, 2);
    assert.equal(r.violations[0]!.mode, "claim");
    assert.equal(r.violations[0]!.observed?.receiverId, "mallory.testnet");
  });

  test("one run with wrong deposit amount is flagged", () => {
    const runs = [
      mkHandoffAudit(1, "claim", false, true, "bob.testnet", "10000", {
        receiptId: "r1",
        receiverId: "bob.testnet",
        depositYocto: "9999", // short
        succeeded: true,
      }),
    ];
    const r = computeAtomicityInvariant(runs);
    assert.equal(r.held, false);
    assert.equal(r.violations[0]!.observed?.depositYocto, "9999");
    assert.equal(r.violations[0]!.expectedAmountYocto, "10000");
  });

  test("one run with failed Transfer outcome is flagged", () => {
    const runs = [
      mkHandoffAudit(1, "claim", false, true, "bob.testnet", "10000", {
        receiptId: "r1",
        receiverId: "bob.testnet",
        depositYocto: "10000",
        succeeded: false, // Transfer reverted
      }),
    ];
    const r = computeAtomicityInvariant(runs);
    assert.equal(r.held, false);
    assert.equal(r.violations[0]!.observed?.succeeded, false);
  });

  test("not-evaluable run counts separately", () => {
    const runs = [
      mkHandoffAudit(1, "claim", true, true, "bob.testnet", "10000", {
        receiptId: "r1",
        receiverId: "bob.testnet",
        depositYocto: "10000",
        succeeded: true,
      }),
      mkHandoffAudit(2, "claim", false, false, "bob.testnet", "10000", null), // no Transfer found
    ];
    const r = computeAtomicityInvariant(runs);
    assert.equal(r.runsNotEvaluable, 1);
    assert.equal(r.runsAtomicallyHeld, 1);
    // 1 evaluated run, 1 held — evaluated === held === 1, so held=true.
    // (Not-evaluable runs aren't violations; they're inconclusive.)
    assert.equal(r.held, true);
  });
});

// ---------------------------------------------------------------------------
// computeShardInvariant
// ---------------------------------------------------------------------------

// Builder for per-run ShardInvariantResult fixtures. `wrongCount` lets
// us simulate a run where k of N callback receipts landed on the wrong
// shard without synthesizing real receipt IDs; the sum receiptsChecked
// stays internally consistent.
function mkShardResult(opts: {
  contractShard: number | null;
  receiptsChecked: number;
  wrongCount?: number;
  evaluable?: boolean;
}): ShardInvariantResult {
  const wrongCount = opts.wrongCount ?? 0;
  const evaluable = opts.evaluable ?? (opts.contractShard !== null && opts.receiptsChecked > 0);
  const wrongShardReceipts = Array.from({ length: wrongCount }, (_, i) => ({
    receiptId: `wrong-${i}`,
    executorId: "recipes.test",
    event: "recipe_resolved_ok",
    observedShard: opts.contractShard !== null ? opts.contractShard + 1 : null,
  }));
  return {
    held: evaluable && wrongCount === 0,
    evaluable,
    contractId: "recipes.test",
    contractShard: opts.contractShard,
    receiptsChecked: opts.receiptsChecked,
    wrongShardReceipts,
  };
}

group("computeShardInvariant (per-recipe shard-placement roll-up)", () => {
  test("empty runs → held=false (nothing evaluated)", () => {
    const r = computeShardInvariant([]);
    assert.equal(r.held, false); // 0 runs is useless signal; same defensive as atomicity
    assert.equal(r.runsChecked, 0);
    assert.equal(r.runsOnContractShard, 0);
    assert.equal(r.runsWithWrongShard, 0);
    assert.equal(r.runsNotEvaluable, 0);
  });

  test("all runs on contract shard → held=true with receipt totals", () => {
    const runs: ShardInputRun[] = [
      { runIndex: 1, shardInvariant: mkShardResult({ contractShard: 4, receiptsChecked: 2 }) },
      { runIndex: 2, shardInvariant: mkShardResult({ contractShard: 4, receiptsChecked: 3 }) },
    ];
    const r = computeShardInvariant(runs);
    assert.equal(r.held, true);
    assert.equal(r.runsChecked, 2);
    assert.equal(r.runsOnContractShard, 2);
    assert.equal(r.totalReceiptsChecked, 5);
    assert.equal(r.totalReceiptsOnContractShard, 5);
    assert.deepEqual(r.contractShards, [4]);
  });

  test("one run with a wrong-shard receipt flips held=false", () => {
    const runs: ShardInputRun[] = [
      { runIndex: 1, shardInvariant: mkShardResult({ contractShard: 4, receiptsChecked: 3 }) },
      {
        runIndex: 2,
        mode: "claim",
        shardInvariant: mkShardResult({ contractShard: 4, receiptsChecked: 3, wrongCount: 1 }),
      },
    ];
    const r = computeShardInvariant(runs);
    assert.equal(r.held, false);
    assert.equal(r.runsChecked, 2);
    assert.equal(r.runsOnContractShard, 1);
    assert.equal(r.runsWithWrongShard, 1);
    assert.equal(r.totalReceiptsChecked, 6);
    assert.equal(r.totalReceiptsOnContractShard, 5);
    assert.equal(r.violations.length, 1);
    assert.equal(r.violations[0]!.runIndex, 2);
    assert.equal(r.violations[0]!.mode, "claim");
    assert.equal(r.violations[0]!.wrongShardReceipts.length, 1);
  });

  test("not-evaluable runs don't count toward runsChecked or violations", () => {
    const runs: ShardInputRun[] = [
      {
        runIndex: 1,
        shardInvariant: mkShardResult({
          contractShard: null,
          receiptsChecked: 0,
          evaluable: false,
        }),
      },
      { runIndex: 2, shardInvariant: mkShardResult({ contractShard: 4, receiptsChecked: 2 }) },
    ];
    const r = computeShardInvariant(runs);
    assert.equal(r.runsNotEvaluable, 1);
    assert.equal(r.runsChecked, 1);
    assert.equal(r.runsOnContractShard, 1);
    assert.equal(r.held, true); // 1 evaluable run, on-shard — enough signal
  });

  test("runs across distinct contract shards are all recorded", () => {
    // Normally a single recipe/network has one contract shard. But if
    // a corpus spans networks (testnet shard 4, mainnet shard 1) the
    // summary should list both shards it anchored to.
    const runs: ShardInputRun[] = [
      { runIndex: 1, shardInvariant: mkShardResult({ contractShard: 4, receiptsChecked: 2 }) },
      { runIndex: 2, shardInvariant: mkShardResult({ contractShard: 1, receiptsChecked: 3 }) },
    ];
    const r = computeShardInvariant(runs);
    assert.equal(r.held, true);
    assert.deepEqual(r.contractShards, [1, 4]);
  });

  test("runs without shardInvariant (back-compat audits) count as inconclusive", () => {
    // Older audit.json files written before the shardInvariant field
    // should be treated as "not evaluable" rather than crash the
    // aggregator. This matches how the budget invariant handles
    // pre-existing claim-mode handoff runs.
    const runs: ShardInputRun[] = [
      { runIndex: 1 }, // no shardInvariant
      { runIndex: 2, shardInvariant: mkShardResult({ contractShard: 4, receiptsChecked: 2 }) },
    ];
    const r = computeShardInvariant(runs);
    assert.equal(r.runsNotEvaluable, 1);
    assert.equal(r.runsChecked, 1);
    assert.equal(r.held, true);
  });
});

// ---------------------------------------------------------------------------
// Summary
// ---------------------------------------------------------------------------

process.stdout.write(`\n${passed} passed, ${failed} failed\n`);
if (failed > 0) {
  process.stdout.write("\nFailures:\n");
  for (const f of failures) process.stdout.write(`  ${f}\n`);
  process.exit(1);
}
