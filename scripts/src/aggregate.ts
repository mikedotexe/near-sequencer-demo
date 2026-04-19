// Per-recipe run aggregation. Each recipe summarizes its runs' lifecycle
// metrics (block deltas, resolved-ok rate, observed counter-value range)
// and writes `artifacts/<network>/recipe-<name>/summary.json`.

import { readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { ARTIFACTS_DIR } from "./config.js";
import type { Audit, BasicAudit, ChainedAudit, HandoffAudit, TimeoutAudit } from "./audit.js";
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

export interface BasicSummary {
  recipe: "basic";
  runCount: number;
  resolvedOkCount: number;
  blocksFromYieldToResume: StatRange;
  blocksFromResumeToCallback: StatRange;
  runs: BasicAudit[];
}

export interface TimeoutSummary {
  recipe: "timeout";
  runCount: number;
  timeoutFiredCount: number;
  blocksFromYieldToCallback: StatRange;
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
      runs,
    };
  } else if (recipe === "timeout") {
    const runs = audits.filter((a): a is TimeoutAudit => a.recipe === "timeout");
    summary = {
      recipe: "timeout",
      runCount: runs.length,
      timeoutFiredCount: runs.filter((r) => r.timeoutFired).length,
      blocksFromYieldToCallback: stat(runs.map((r) => r.blocksFromYieldToCallback)),
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
