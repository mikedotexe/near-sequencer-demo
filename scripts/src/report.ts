// Per-recipe teaching report. Produces `artifacts/<network>/report.md`
// with one section per recipe: tx-hash table linked to the explorer plus
// the observed block-level shape.

import { writeFileSync } from "node:fs";
import { join } from "node:path";

import { ACCOUNTS, ARTIFACTS_DIR, BOB_ACCOUNT_ID, EXPLORER_BASE, NEAR_NETWORK } from "./config.js";
import {
  summarizeAll,
  type AtomicityInvariantSummary,
  type BudgetInvariantSummary,
  type DagInvariantSummary,
  type HandoffSummary,
  type RecipeSummary,
  type TimeoutSummary,
} from "./aggregate.js";
import type { SnapshotStatus } from "./snapshot.js";

function fmtYoctoAsNear(yocto: string | null): string {
  if (yocto === null) return "n/a";
  try {
    const y = BigInt(yocto);
    // yocto -> NEAR with 4 decimal places, dropping trailing zeros.
    const whole = y / 10n ** 24n;
    const frac = y % 10n ** 24n;
    if (frac === 0n) return `${whole} NEAR`;
    const fracStr = frac.toString().padStart(24, "0").slice(0, 4).replace(/0+$/, "");
    return fracStr ? `${whole}.${fracStr} NEAR` : `${whole} NEAR`;
  } catch {
    return `${yocto} yocto`;
  }
}

function fmt(n: number | null): string {
  return n === null ? "—" : String(n);
}

// Same as fmt() but distinguishes null because-snapshot-failed from
// null because-not-applicable. Use where the cell's value depends on a
// snapshotted tx (block deltas, resume heights); stick with fmt() for
// cells that are intrinsically optional (not applicable in a given mode).
function fmtCell(n: number | null, snapshotStatus: SnapshotStatus | undefined): string {
  if (n !== null) return String(n);
  // Back-compat: audits written before snapshotStatus existed default to
  // "complete" semantics — render "—" rather than a false alarm.
  if (!snapshotStatus || snapshotStatus.overall === "complete") return "—";
  return "**snapshot failed**";
}

function heading(r: RecipeSummary["recipe"]): string {
  switch (r) {
    case "basic":
      return "Recipe 1 — Basic cross-tx yield + resume";
    case "timeout":
      return "Recipe 2 — Timeout: what happens when no one resumes";
    case "chained":
      return "Recipe 3 — Chained: resume triggers a downstream call with callback";
    case "handoff":
      return "Recipe 4 — Atomic handoff: value moves on resume or refunds on timeout";
  }
}

function runsTable(s: RecipeSummary): string {
  if (s.recipe === "basic") {
    const rows = s.runs.map(
      (r) =>
        `| ${r.runIndex} | \`${r.yieldTxHash.slice(0, 12)}…\` | \`${r.resumeTxHash.slice(0, 12)}…\` | ${r.resolvedOk ? "ok" : "**fail**"} | ${fmtCell(r.blocksFromYieldToResume, r.snapshotStatus)} | ${fmtCell(r.blocksFromResumeToCallback, r.snapshotStatus)} | [explorer](${r.explorerUrl}) |`,
    );
    return [
      "| run | yield tx | resume tx | outcome | yield→resume (blocks) | resume→callback (blocks) | link |",
      "|-----|----------|-----------|---------|-----------------------|--------------------------|------|",
      ...rows,
    ].join("\n");
  }
  if (s.recipe === "timeout") {
    const rows = s.runs.map(
      (r) =>
        `| ${r.runIndex} | \`${r.yieldTxHash.slice(0, 12)}…\` | ${r.timeoutFired ? "fired" : "**not detected**"} | ${fmtCell(r.blocksFromYieldToCallback, r.snapshotStatus)} | [explorer](${r.explorerUrl}) |`,
    );
    return [
      "| run | yield tx | timeout | yield→callback (blocks) | link |",
      "|-----|----------|---------|-------------------------|------|",
      ...rows,
    ].join("\n");
  }
  if (s.recipe === "chained") {
    const rows = s.runs.map(
      (r) =>
        `| ${r.runIndex} | \`${r.yieldTxHash.slice(0, 12)}…\` | \`${r.resumeTxHash.slice(0, 12)}…\` | ${r.delta > 0 ? "+1" : "-1"} | ${fmt(r.observedValue)} | ${r.resolvedOk ? "ok" : "**fail**"} | ${fmtCell(r.blocksFromYieldToResume, r.snapshotStatus)} | ${fmtCell(r.blocksFromResumeToDispatch, r.snapshotStatus)} | ${fmtCell(r.blocksFromDispatchToCallback, r.snapshotStatus)} | [explorer](${r.explorerUrl}) |`,
    );
    return [
      "| run | yield tx | resume tx | delta | observed counter | outcome | y→r (b) | r→d (b) | d→cb (b) | link |",
      "|-----|----------|-----------|-------|------------------|---------|---------|---------|----------|------|",
      ...rows,
    ].join("\n");
  }
  // handoff
  const rows = s.runs.map((r) => {
    const resumeCell = r.resumeTxHash ? `\`${r.resumeTxHash.slice(0, 12)}…\`` : "—";
    const outcome =
      r.mode === "claim"
        ? r.settledOk
          ? "claimed"
          : "**fail**"
        : r.settledOk
          ? "**unexpected claim**"
          : "refunded";
    const landedOn = r.fundsRecipient ? `\`${r.fundsRecipient}\`` : "—";
    // yield→resume is intrinsically null for timeout mode (no resume exists),
    // so use fmt() there; yield→settle derives from the yield tx, so it goes
    // through fmtCell() to surface snapshot failures.
    return `| ${r.runIndex} | ${r.mode} | \`${r.yieldTxHash.slice(0, 12)}…\` | ${resumeCell} | ${outcome} | ${landedOn} | ${fmt(r.blocksFromYieldToResume)} | ${fmtCell(r.blocksFromYieldToSettle, r.snapshotStatus)} | [explorer](${r.explorerUrl}) |`;
  });
  return [
    "| run | mode | yield tx | resume tx | outcome | funds landed on | y→resume (b) | y→settle (b) | link |",
    "|-----|------|----------|-----------|---------|-----------------|--------------|--------------|------|",
    ...rows,
  ].join("\n");
}

function aggBlock(s: RecipeSummary): string {
  if (s.recipe === "basic") {
    return [
      `- runs: ${s.runCount} (resolved_ok: ${s.resolvedOkCount})`,
      `- yield→resume (blocks): median=${fmt(s.blocksFromYieldToResume.median)}, min=${fmt(s.blocksFromYieldToResume.min)}, max=${fmt(s.blocksFromYieldToResume.max)}`,
      `- resume→callback (blocks): median=${fmt(s.blocksFromResumeToCallback.median)}, min=${fmt(s.blocksFromResumeToCallback.min)}, max=${fmt(s.blocksFromResumeToCallback.max)}`,
    ].join("\n");
  }
  if (s.recipe === "timeout") {
    return [
      `- runs: ${s.runCount} (timeout_fired: ${s.timeoutFiredCount})`,
      `- yield→callback (blocks): median=${fmt(s.blocksFromYieldToCallback.median)}, min=${fmt(s.blocksFromYieldToCallback.min)}, max=${fmt(s.blocksFromYieldToCallback.max)}`,
      `- expected: ~200 blocks (NEP-519 budget). Observed deltas close to 200 confirm the timeout fires as specified.`,
    ].join("\n");
  }
  if (s.recipe === "chained") {
    return [
      `- runs: ${s.runCount} (resolved_ok: ${s.resolvedOkCount})`,
      `- observed counter values: [${s.observedValues.join(", ") || "none"}]`,
      `- yield→resume (blocks): median=${fmt(s.blocksFromYieldToResume.median)}, min=${fmt(s.blocksFromYieldToResume.min)}, max=${fmt(s.blocksFromYieldToResume.max)}`,
      `- resume→dispatch (blocks): median=${fmt(s.blocksFromResumeToDispatch.median)}, min=${fmt(s.blocksFromResumeToDispatch.min)}, max=${fmt(s.blocksFromResumeToDispatch.max)}`,
      `- dispatch→callback (blocks): median=${fmt(s.blocksFromDispatchToCallback.median)}, min=${fmt(s.blocksFromDispatchToCallback.min)}, max=${fmt(s.blocksFromDispatchToCallback.max)}`,
    ].join("\n");
  }
  // handoff
  return [
    `- runs: ${s.runCount} (claim: ${s.claimCount}, timeout: ${s.timeoutCount}; settled_ok: ${s.settledOkCount})`,
    `- amount per handoff: ${fmtYoctoAsNear(s.amountYocto)}`,
    `- claim: yield→resume (blocks): median=${fmt(s.blocksFromYieldToResume.median)}, min=${fmt(s.blocksFromYieldToResume.min)}, max=${fmt(s.blocksFromYieldToResume.max)}`,
    `- claim: yield→settle (blocks): median=${fmt(s.claimYieldToSettle.median)}, min=${fmt(s.claimYieldToSettle.min)}, max=${fmt(s.claimYieldToSettle.max)}`,
    `- timeout: yield→settle (blocks): median=${fmt(s.timeoutYieldToSettle.median)}, min=${fmt(s.timeoutYieldToSettle.min)}, max=${fmt(s.timeoutYieldToSettle.max)} (NEP-519 budget = 200)`,
  ].join("\n");
}

// Renders the per-recipe DAG-placement invariant status. The invariant
// is defined in audit.ts: every callback-emitted trace event must land in
// the YIELD tx's DAG, not the resume tx's. Populated by computeDagInvariant
// in aggregate.ts from each per-run `dagPlacement` / `dagInvariantViolations`.
function dagInvariantLine(dag: DagInvariantSummary): string {
  const runsWord = dag.runsChecked === 1 ? "run" : "runs";
  if (dag.held) {
    return `- DAG-placement invariant: **PASS** (${dag.eventsInExpectedPlace}/${dag.eventsChecked} trace events across ${dag.runsChecked} ${runsWord} land in the expected tx DAG — the yield tx is the root of the receipt tree)`;
  }
  return `- DAG-placement invariant: **VIOLATED** in ${dag.runsWithViolations}/${dag.runsChecked} ${runsWord} (${dag.eventsInExpectedPlace}/${dag.eventsChecked} events in expected place — see violations below)`;
}

// Per-recipe NEP-519 budget invariant line. yield→callback block delta
// must lie in [lowerBound, upperBound]. Skipped when no runs were
// evaluable (e.g. recipe hasn't run yet).
function budgetInvariantLine(budget: BudgetInvariantSummary): string | null {
  if (budget.runsChecked === 0 && budget.runsNotEvaluable === 0) return null;
  const runsWord = budget.runsChecked === 1 ? "run" : "runs";
  const range = `[${budget.lowerBound}, ${budget.upperBound}]`;
  const observed = budget.observedBlocks.length > 0 ? budget.observedBlocks.join(", ") : "—";
  if (budget.held && budget.runsChecked > 0) {
    return `- Budget invariant (NEP-519 200-block timeout): **PASS** (${budget.runsInRange}/${budget.runsChecked} ${runsWord} inside ${range} blocks; observed=${observed})`;
  }
  if (budget.runsNotEvaluable > 0 && budget.runsChecked === 0) {
    return `- Budget invariant: **inconclusive** (${budget.runsNotEvaluable} run(s) had no callback receipt in the snapshot)`;
  }
  return `- Budget invariant: **VIOLATED** (${budget.runsOutOfRange}/${budget.runsChecked} ${runsWord} outside ${range}; observed=${observed})`;
}

// Per-recipe atomicity invariant line (Recipe 4 only). Every evaluable
// run must have a Transfer receipt from the recipes contract to the
// expected recipient with the expected amount and a SuccessValue outcome.
function atomicityInvariantLine(atomicity: AtomicityInvariantSummary): string {
  const runsWord = atomicity.runsChecked === 1 ? "run" : "runs";
  if (atomicity.held) {
    return `- Atomicity invariant: **PASS** (${atomicity.runsAtomicallyHeld}/${atomicity.runsChecked} ${runsWord}: each snapshotted Transfer matches expected recipient + amount + succeeded)`;
  }
  if (atomicity.runsNotEvaluable > 0 && atomicity.runsAtomicallyHeld + atomicity.violations.length === 0) {
    return `- Atomicity invariant: **inconclusive** (${atomicity.runsNotEvaluable}/${atomicity.runsChecked} ${runsWord} had no Transfer receipt in the snapshot)`;
  }
  return `- Atomicity invariant: **VIOLATED** in ${atomicity.violations.length}/${atomicity.runsChecked} ${runsWord} (see violations below)`;
}

function budgetViolationsTable(budget: BudgetInvariantSummary): string {
  const rows = budget.violations.map((v) => {
    const runLabel =
      v.mode !== undefined
        ? `${v.mode}-${v.runIndex.toString().padStart(2, "0")}`
        : v.runIndex.toString().padStart(2, "0");
    return `| ${runLabel} | ${v.observedBlocks} | [${budget.lowerBound}, ${budget.upperBound}] |`;
  });
  return [
    "**Budget invariant violations:**",
    "",
    "| run | yield→callback (blocks) | expected range |",
    "|-----|-------------------------|----------------|",
    ...rows,
  ].join("\n");
}

function atomicityViolationsTable(atomicity: AtomicityInvariantSummary): string {
  const rows = atomicity.violations.map((v) => {
    const runLabel = `${v.mode}-${v.runIndex.toString().padStart(2, "0")}`;
    const observedCell = v.observed
      ? `\`${v.observed.receiverId}\`, ${v.observed.depositYocto} yocto, succeeded=${v.observed.succeeded}`
      : "no matching Transfer receipt";
    return `| ${runLabel} | \`${v.expectedRecipient}\`, ${v.expectedAmountYocto} yocto | ${observedCell} |`;
  });
  return [
    "**Atomicity invariant violations:**",
    "",
    "| run | expected | observed |",
    "|-----|----------|----------|",
    ...rows,
  ].join("\n");
}

// Top-line invariant summary. Walks every recipe summary, enumerates each
// applicable invariant, and returns a single PASS/FAIL line. This is the
// first line a reader sees after the report's preamble — the claim-to-
// evidence loop closed at a glance. Format: one bullet per invariant.
function topLineInvariantBadge(summaries: RecipeSummary[]): string[] {
  // DAG-placement — applies to every recipe.
  const dagRunsChecked = summaries.reduce((n, s) => n + s.dagInvariant.runsChecked, 0);
  const dagEventsChecked = summaries.reduce((n, s) => n + s.dagInvariant.eventsChecked, 0);
  const dagEventsInPlace = summaries.reduce((n, s) => n + s.dagInvariant.eventsInExpectedPlace, 0);
  const dagViolatingRuns = summaries.reduce((n, s) => n + s.dagInvariant.runsWithViolations, 0);
  const dagHeld = dagViolatingRuns === 0;

  // Budget — applies to timeout + handoff summaries when they have timeout runs.
  const budgetSummaries = summaries.flatMap<BudgetInvariantSummary>((s) => {
    if (s.recipe === "timeout") return [(s as TimeoutSummary).budgetInvariant];
    if (s.recipe === "handoff") return [(s as HandoffSummary).budgetInvariant];
    return [];
  });
  const budgetRunsChecked = budgetSummaries.reduce((n, b) => n + b.runsChecked, 0);
  const budgetRunsInRange = budgetSummaries.reduce((n, b) => n + b.runsInRange, 0);
  const budgetRunsOutOfRange = budgetSummaries.reduce((n, b) => n + b.runsOutOfRange, 0);
  const budgetHeld = budgetRunsOutOfRange === 0;

  // Atomicity — applies to handoff only.
  const handoff = summaries.find((s) => s.recipe === "handoff") as HandoffSummary | undefined;
  const atomicity = handoff?.atomicityInvariant;

  const allHeld =
    dagHeld && budgetHeld && (atomicity === undefined || atomicity.held);
  const header = allHeld
    ? "**Invariants:** all three hold on the snapshotted runs."
    : "**Invariants:** one or more violated — see the per-recipe sections below.";
  const bullets: string[] = [header, ""];
  bullets.push(
    dagHeld
      ? `- DAG-placement: **PASS** (${dagEventsInPlace}/${dagEventsChecked} trace events across ${dagRunsChecked} runs land in the expected yield-tx DAG)`
      : `- DAG-placement: **FAIL** (${dagViolatingRuns}/${dagRunsChecked} runs violated; ${dagEventsInPlace}/${dagEventsChecked} events in expected place)`,
  );
  if (budgetRunsChecked > 0) {
    bullets.push(
      budgetHeld
        ? `- Budget (NEP-519 200-block timeout): **PASS** (${budgetRunsInRange}/${budgetRunsChecked} runs inside the expected block window)`
        : `- Budget: **FAIL** (${budgetRunsOutOfRange}/${budgetRunsChecked} runs outside the expected block window)`,
    );
  }
  if (atomicity && atomicity.runsChecked > 0) {
    bullets.push(
      atomicity.held
        ? `- Atomicity (Recipe 4): **PASS** (${atomicity.runsAtomicallyHeld}/${atomicity.runsChecked} runs: each snapshotted Transfer matches recipient + amount + succeeded)`
        : `- Atomicity (Recipe 4): **FAIL** (${atomicity.violations.length}/${atomicity.runsChecked} runs)`,
    );
  }
  return bullets;
}

// Emits a line only when one or more runs had a degraded snapshot. A
// complete snapshot is the typical case; the line would be noise.
function snapshotHealthLine(s: RecipeSummary): string | null {
  let partial = 0;
  let failed = 0;
  for (const r of s.runs) {
    const overall = r.snapshotStatus?.overall ?? "complete";
    if (overall === "partial") partial++;
    else if (overall === "failed") failed++;
  }
  const degraded = partial + failed;
  if (degraded === 0) return null;
  const parts: string[] = [];
  if (partial > 0) parts.push(`partial=${partial}`);
  if (failed > 0) parts.push(`failed=${failed}`);
  return `- snapshots: ${degraded}/${s.runs.length} degraded (${parts.join(", ")}) — affected cells render as **snapshot failed**`;
}

function dagViolationsTable(recipe: RecipeSummary["recipe"], dag: DagInvariantSummary): string {
  const rows = dag.violations.map((v) => {
    const runLabel =
      recipe === "handoff" && v.mode
        ? `${v.mode}-${v.runIndex.toString().padStart(2, "0")}`
        : v.runIndex.toString().padStart(2, "0");
    return `| ${runLabel} | \`${v.event}\` | ${v.expected} | ${v.actual ?? "no snapshotted tx"} |`;
  });
  return [
    "**DAG-placement violations:**",
    "",
    "| run | event | expected tx DAG | actual tx DAG |",
    "|-----|-------|-----------------|---------------|",
    ...rows,
  ].join("\n");
}

function interpretRecipe(s: RecipeSummary): string {
  if (s.recipe === "basic") {
    return "Each run yields in tx1, persisting the YieldId under `basic:<name>` in contract state. `Promise::new_yield` schedules the callback receipt at yield time — it lives in tx1's DAG, waiting for input. tx2 reads the YieldId and calls `yield_id.resume(...)`, which delivers the payload to that already-scheduled receipt; the callback executes and emits `recipe_resolved_ok`, still inside tx1's DAG. `resume→callback` is typically 1–2 blocks, reflecting how quickly the runtime picks up the waiting receipt after resume lands.";
  }
  if (s.recipe === "timeout") {
    return "The yield tx registers a yielded callback receipt at yield time and no resume is ever sent. After NEP-519's fixed 200-block budget elapses, the runtime delivers `PromiseError` to the already-scheduled callback, which runs with `#[callback_result] = Err(PromiseError)`. The contract's match arm records `recipe_resolved_err`. This confirms: **the callback always fires exactly once per yield, even in the absence of a resume**. (Observable evidence: the callback's receipt outcome is present in the yield tx's DAG, not a separate tx.)";
  }
  if (s.recipe === "chained") {
    return "When resume lands, the pre-scheduled `on_chained_resumed` executes and dispatches `counter.increment()` (or decrement if delta < 0), chaining `.then(on_counter_observed)`. The counter callback reads the target's `#[callback_result] i8` and emits `recipe_callback_observed` with the new value. Only after that callback sees a truthful return does the recipe's own receipt resolve. Every downstream trace event — `recipe_dispatched`, `recipe_callback_observed`, `recipe_resolved_ok` — lives in the yield tx's DAG, not the resume tx's; resume is just the data delivery that unblocks the waiting receipt tree.";
  }
  // handoff
  return "Alice yields `recipe_handoff_yield(name, to=bob)` with 0.01 NEAR attached; the contract receives the deposit and schedules a callback parameterised with `(from, to, amount)`. On claim, a resume tx fires `recipe_handoff_resume(name)` and the waiting callback's Ok arm runs `Promise::new(to).transfer(amount)` — the funds flow to the nominated recipient, wherever the resumer came from. On timeout, no resume is ever sent; after 200 blocks the runtime delivers `PromiseError` to the same callback, whose Err arm runs `Promise::new(from).transfer(amount)` and refunds Alice. **The single receipt scheduled at yield time carries both endings.** No escrow table, no refund method, no polling — the yield/resume primitive alone moves value atomically, with the 200-block budget as the built-in safety valve.";
}

export function writeReport(): string {
  const summaries = summarizeAll();

  const lines: string[] = [];
  const networkLabel = NEAR_NETWORK === "mainnet" ? "NEAR mainnet" : "NEAR testnet";
  lines.push(`# NEP-519 recipe book — ${networkLabel} report`);
  lines.push("");
  lines.push(
    `Generated by \`scripts/demo.sh report\` after running the four recipes on ${networkLabel}. Each recipe section lists the runs, links to their transactions on ${EXPLORER_BASE}, and reports the observable block-level lifecycle.`,
  );
  lines.push("");
  lines.push("## Invariants at a glance");
  lines.push("");
  for (const l of topLineInvariantBadge(summaries)) lines.push(l);
  lines.push("");
  lines.push("## Accounts");
  lines.push("");
  for (const [role, id] of Object.entries(ACCOUNTS)) {
    lines.push(`- \`${role}\` → \`${id}\``);
  }
  lines.push(`- \`bob\` (handoff recipient) → \`${BOB_ACCOUNT_ID}\``);
  lines.push("");

  for (const s of summaries) {
    lines.push(`## ${heading(s.recipe)}`);
    lines.push("");
    lines.push(aggBlock(s));
    lines.push(dagInvariantLine(s.dagInvariant));
    if (s.recipe === "timeout") {
      const line = budgetInvariantLine(s.budgetInvariant);
      if (line) lines.push(line);
    }
    if (s.recipe === "handoff") {
      const budgetLine = budgetInvariantLine(s.budgetInvariant);
      if (budgetLine) lines.push(budgetLine);
      lines.push(atomicityInvariantLine(s.atomicityInvariant));
    }
    const snapLine = snapshotHealthLine(s);
    if (snapLine) lines.push(snapLine);
    lines.push("");
    lines.push(runsTable(s));
    lines.push("");
    if (!s.dagInvariant.held) {
      lines.push(dagViolationsTable(s.recipe, s.dagInvariant));
      lines.push("");
    }
    if (s.recipe === "timeout" && !s.budgetInvariant.held && s.budgetInvariant.runsOutOfRange > 0) {
      lines.push(budgetViolationsTable(s.budgetInvariant));
      lines.push("");
    }
    if (s.recipe === "handoff") {
      if (!s.budgetInvariant.held && s.budgetInvariant.runsOutOfRange > 0) {
        lines.push(budgetViolationsTable(s.budgetInvariant));
        lines.push("");
      }
      if (!s.atomicityInvariant.held && s.atomicityInvariant.violations.length > 0) {
        lines.push(atomicityViolationsTable(s.atomicityInvariant));
        lines.push("");
      }
    }
    lines.push(`**Interpretation:** ${interpretRecipe(s)}`);
    lines.push("");
  }

  lines.push("## How to reproduce");
  lines.push("");
  lines.push("```sh");
  lines.push("scripts/demo.sh build");
  lines.push("scripts/demo.sh deploy");
  lines.push("scripts/demo.sh run basic --repeat 3");
  lines.push("scripts/demo.sh run timeout --repeat 1   # each run waits ~4 min");
  lines.push("scripts/demo.sh run chained --repeat 3");
  lines.push("scripts/demo.sh run handoff --mode claim --repeat 2");
  lines.push("scripts/demo.sh run handoff --mode timeout --repeat 1   # each waits ~4 min");
  lines.push("scripts/demo.sh audit basic && scripts/demo.sh audit timeout \\");
  lines.push("    && scripts/demo.sh audit chained && scripts/demo.sh audit handoff");
  lines.push("scripts/demo.sh aggregate && scripts/demo.sh report");
  lines.push("```");
  lines.push("");
  lines.push(
    `Every tx hash above links to ${EXPLORER_BASE}, so each lifecycle claim is independently verifiable from the public chain. Sibling \`run-NN.onchain.json\` files snapshot the same data locally (full receipt DAGs, blocks, chunks) for offline reanalysis.`,
  );
  lines.push("");

  const path = join(ARTIFACTS_DIR, "report.md");
  writeFileSync(path, lines.join("\n"));
  return path;
}
