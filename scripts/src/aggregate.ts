// Per-recipe run aggregation. Each recipe summarizes its runs' lifecycle
// metrics (block deltas, resolved-ok rate, observed counter-value range)
// and writes `artifacts/<network>/recipe-<name>/summary.json`.

import { readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { ARTIFACTS_DIR } from "./config.js";
import type {
  Audit,
  AtomicityInvariantResult,
  BasicAudit,
  BudgetInvariantResult,
  ChainedAudit,
  HandoffAudit,
  TimeoutAudit,
  TxRole,
} from "./audit.js";
import { RECIPE_NAMES, type RecipeName } from "./recipes/types.js";

interface StatRange {
  min: number | null;
  max: number | null;
  median: number | null;
  count: number;
}

function stat(values: Array<number | null>): StatRange {
  const known = values.filter((v): v is number => v !== null);
  if (known.length === 0) return { min: null, max: null, median: null, count: 0 };
  const sorted = [...known].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  const median = sorted.length % 2 === 0 ? (sorted[mid - 1]! + sorted[mid]!) / 2 : sorted[mid]!;
  return { min: sorted[0]!, max: sorted[sorted.length - 1]!, median, count: known.length };
}

// Per-recipe roll-up of the per-run DAG-placement invariant check. The
// invariant is defined in audit.ts's computeDagPlacement: every callback
// trace event (recipe_resolved_*, recipe_dispatched, recipe_callback_observed,
// handoff_released, handoff_refunded) must land in the YIELD tx's DAG, not
// the resume tx's. This summary propagates the per-run results so report.md
// can show a PASS/VIOLATED line without re-reading each audit.json.
export interface DagInvariantSummary {
  held: boolean;
  runsChecked: number;
  runsWithViolations: number;
  eventsChecked: number;
  eventsInExpectedPlace: number;
  violations: Array<{
    runIndex: number;
    mode?: "claim" | "timeout";
    event: string;
    expected: TxRole;
    actual: TxRole | null;
  }>;
}

// Per-recipe roll-up of the NEP-519 200-block budget invariant. The
// per-run check lives in audit.ts's checkBudget; here we collect the
// observed blocks across runs, count how many fell inside the expected
// window, and note any violations. Applicable to timeout recipe (all
// runs) and handoff recipe (timeout-mode runs only).
export interface BudgetInvariantSummary {
  held: boolean;
  runsChecked: number;        // runs with an evaluable budget check
  runsInRange: number;
  runsOutOfRange: number;
  runsNotEvaluable: number;   // callback receipt missing from snapshot
  lowerBound: number;
  upperBound: number;
  observedBlocks: number[];
  violations: Array<{
    runIndex: number;
    mode?: "claim" | "timeout";
    observedBlocks: number;
  }>;
}

export interface BudgetInputRun {
  runIndex: number;
  mode?: "claim" | "timeout";
  budgetInvariant?: BudgetInvariantResult;
}

// Export form is the pure-data surface that scripts/test exercises.
// It's split from the per-recipe summarize paths so tests don't have to
// pretend to be auditing the whole recipe corpus to exercise a single
// aggregation pass.
export function computeBudgetInvariant(runs: BudgetInputRun[]): BudgetInvariantSummary {
  const applicable = runs.filter((r) => r.budgetInvariant !== undefined);
  let runsInRange = 0;
  let runsOutOfRange = 0;
  let runsNotEvaluable = 0;
  const observedBlocks: number[] = [];
  const violations: BudgetInvariantSummary["violations"] = [];
  let lowerBound = 0;
  let upperBound = 0;
  for (const r of applicable) {
    const b = r.budgetInvariant!;
    lowerBound = b.lowerBound;
    upperBound = b.upperBound;
    if (!b.evaluable) {
      runsNotEvaluable++;
      continue;
    }
    if (b.held) {
      runsInRange++;
      observedBlocks.push(b.observedBlocks!);
    } else {
      runsOutOfRange++;
      observedBlocks.push(b.observedBlocks!);
      violations.push({
        runIndex: r.runIndex,
        ...(r.mode ? { mode: r.mode } : {}),
        observedBlocks: b.observedBlocks!,
      });
    }
  }
  return {
    held: runsOutOfRange === 0,
    runsChecked: runsInRange + runsOutOfRange,
    runsInRange,
    runsOutOfRange,
    runsNotEvaluable,
    lowerBound,
    upperBound,
    observedBlocks,
    violations,
  };
}

// Per-recipe roll-up of Recipe 4's atomicity invariant. Per-run check
// lives in audit.ts's checkAtomicity; here we count how many runs had a
// matching Transfer receipt (predecessor = contract, receiver =
// expectedRecipient, deposit = amountYocto, outcome = SuccessValue).
export interface AtomicityInvariantSummary {
  held: boolean;
  runsChecked: number;
  runsAtomicallyHeld: number;
  runsNotEvaluable: number;
  violations: Array<{
    runIndex: number;
    mode: "claim" | "timeout";
    expectedRecipient: string;
    expectedAmountYocto: string;
    observed: AtomicityInvariantResult["observed"];
  }>;
}

export function computeAtomicityInvariant(runs: HandoffAudit[]): AtomicityInvariantSummary {
  let runsAtomicallyHeld = 0;
  let runsNotEvaluable = 0;
  const violations: AtomicityInvariantSummary["violations"] = [];
  for (const r of runs) {
    const a = r.atomicityInvariant;
    if (!a.evaluable) {
      runsNotEvaluable++;
      continue;
    }
    if (a.held) {
      runsAtomicallyHeld++;
    } else {
      violations.push({
        runIndex: r.runIndex,
        mode: a.mode,
        expectedRecipient: a.expectedRecipient,
        expectedAmountYocto: a.expectedAmountYocto,
        observed: a.observed,
      });
    }
  }
  const evaluated = runs.length - runsNotEvaluable;
  return {
    held: runsAtomicallyHeld === evaluated && evaluated > 0,
    runsChecked: runs.length,
    runsAtomicallyHeld,
    runsNotEvaluable,
    violations,
  };
}

export function computeDagInvariant(audits: Audit[]): DagInvariantSummary {
  let runsWithViolations = 0;
  let eventsChecked = 0;
  let eventsInExpectedPlace = 0;
  const violations: DagInvariantSummary["violations"] = [];
  for (const a of audits) {
    if (a.dagInvariantViolations.length > 0) runsWithViolations++;
    const expectedCount = Object.keys(a.dagPlacement).length;
    const violationCount = a.dagInvariantViolations.length;
    eventsChecked += expectedCount;
    eventsInExpectedPlace += expectedCount - violationCount;
    for (const v of a.dagInvariantViolations) {
      violations.push({
        runIndex: a.runIndex,
        ...(a.recipe === "handoff" ? { mode: a.mode } : {}),
        event: v.event,
        expected: v.expected,
        actual: v.actual,
      });
    }
  }
  return {
    held: runsWithViolations === 0,
    runsChecked: audits.length,
    runsWithViolations,
    eventsChecked,
    eventsInExpectedPlace,
    violations,
  };
}

export interface BasicSummary {
  recipe: "basic";
  runCount: number;
  resolvedOkCount: number;
  blocksFromYieldToResume: StatRange;
  blocksFromResumeToCallback: StatRange;
  dagInvariant: DagInvariantSummary;
  runs: BasicAudit[];
}

export interface TimeoutSummary {
  recipe: "timeout";
  runCount: number;
  timeoutFiredCount: number;
  blocksFromYieldToCallback: StatRange;
  dagInvariant: DagInvariantSummary;
  budgetInvariant: BudgetInvariantSummary;
  runs: TimeoutAudit[];
}

export interface ChainedSummary {
  recipe: "chained";
  runCount: number;
  resolvedOkCount: number;
  blocksFromYieldToResume: StatRange;
  blocksFromResumeToDispatch: StatRange;
  blocksFromDispatchToCallback: StatRange;
  observedValues: number[];
  dagInvariant: DagInvariantSummary;
  runs: ChainedAudit[];
}

export interface HandoffSummary {
  recipe: "handoff";
  runCount: number;
  claimCount: number;
  timeoutCount: number;
  settledOkCount: number;
  amountYocto: string | null;
  blocksFromYieldToResume: StatRange; // claim mode only
  blocksFromYieldToSettle: StatRange; // both modes, segmented below
  // Segmented so the 200-block timeout doesn't swamp the ~few-block
  // claim-path latency when they're reported together.
  claimYieldToSettle: StatRange;
  timeoutYieldToSettle: StatRange;
  dagInvariant: DagInvariantSummary;
  // Budget applies only to timeout runs; summary reflects that (runsChecked
  // counts evaluable timeout runs, not all runs).
  budgetInvariant: BudgetInvariantSummary;
  atomicityInvariant: AtomicityInvariantSummary;
  runs: HandoffAudit[];
}

export type RecipeSummary = BasicSummary | TimeoutSummary | ChainedSummary | HandoffSummary;

export function summarizeRecipe(recipe: RecipeName): RecipeSummary | null {
  const dir = join(ARTIFACTS_DIR, `recipe-${recipe}`);
  let entries: string[];
  try {
    entries = readdirSync(dir)
      .filter((f) => f.endsWith(".audit.json"))
      .sort();
  } catch {
    return null;
  }
  const audits = entries.map((e) => JSON.parse(readFileSync(join(dir, e), "utf8")) as Audit);

  let summary: RecipeSummary;
  if (recipe === "basic") {
    const runs = audits.filter((a): a is BasicAudit => a.recipe === "basic");
    summary = {
      recipe: "basic",
      runCount: runs.length,
      resolvedOkCount: runs.filter((r) => r.resolvedOk).length,
      blocksFromYieldToResume: stat(runs.map((r) => r.blocksFromYieldToResume)),
      blocksFromResumeToCallback: stat(runs.map((r) => r.blocksFromResumeToCallback)),
      dagInvariant: computeDagInvariant(runs),
      runs,
    };
  } else if (recipe === "timeout") {
    const runs = audits.filter((a): a is TimeoutAudit => a.recipe === "timeout");
    summary = {
      recipe: "timeout",
      runCount: runs.length,
      timeoutFiredCount: runs.filter((r) => r.timeoutFired).length,
      blocksFromYieldToCallback: stat(runs.map((r) => r.blocksFromYieldToCallback)),
      dagInvariant: computeDagInvariant(runs),
      budgetInvariant: computeBudgetInvariant(
        runs.map((r) => ({ runIndex: r.runIndex, budgetInvariant: r.budgetInvariant })),
      ),
      runs,
    };
  } else if (recipe === "chained") {
    const runs = audits.filter((a): a is ChainedAudit => a.recipe === "chained");
    summary = {
      recipe: "chained",
      runCount: runs.length,
      resolvedOkCount: runs.filter((r) => r.resolvedOk).length,
      blocksFromYieldToResume: stat(runs.map((r) => r.blocksFromYieldToResume)),
      blocksFromResumeToDispatch: stat(runs.map((r) => r.blocksFromResumeToDispatch)),
      blocksFromDispatchToCallback: stat(runs.map((r) => r.blocksFromDispatchToCallback)),
      observedValues: runs
        .map((r) => r.observedValue)
        .filter((v): v is number => v !== null),
      dagInvariant: computeDagInvariant(runs),
      runs,
    };
  } else {
    const runs = audits.filter((a): a is HandoffAudit => a.recipe === "handoff");
    const claims = runs.filter((r) => r.mode === "claim");
    const timeouts = runs.filter((r) => r.mode === "timeout");
    summary = {
      recipe: "handoff",
      runCount: runs.length,
      claimCount: claims.length,
      timeoutCount: timeouts.length,
      settledOkCount: runs.filter((r) => r.settledOk).length,
      // All runs use the same amount; pick it off the first run (or null
      // if the recipe hasn't run yet).
      amountYocto: runs[0]?.amountYocto ?? null,
      blocksFromYieldToResume: stat(claims.map((r) => r.blocksFromYieldToResume)),
      blocksFromYieldToSettle: stat(runs.map((r) => r.blocksFromYieldToSettle)),
      claimYieldToSettle: stat(claims.map((r) => r.blocksFromYieldToSettle)),
      timeoutYieldToSettle: stat(timeouts.map((r) => r.blocksFromYieldToSettle)),
      dagInvariant: computeDagInvariant(runs),
      budgetInvariant: computeBudgetInvariant(
        timeouts.map((r) => ({
          runIndex: r.runIndex,
          mode: r.mode,
          budgetInvariant: r.budgetInvariant,
        })),
      ),
      atomicityInvariant: computeAtomicityInvariant(runs),
      runs,
    };
  }

  writeFileSync(join(dir, "summary.json"), JSON.stringify(summary, null, 2));
  return summary;
}

export function summarizeAll(): RecipeSummary[] {
  const out: RecipeSummary[] = [];
  for (const recipe of RECIPE_NAMES) {
    const s = summarizeRecipe(recipe);
    if (s) out.push(s);
  }
  return out;
}
