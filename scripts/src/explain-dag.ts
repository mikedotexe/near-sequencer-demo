// Prints the DAG-placement of trace events for a snapshotted run, making
// the empirical finding "callback trace events live in the yield tx's
// DAG" reproducible from any snapshotted `run-NN.onchain.json` without
// requiring the reader to know jq.
//
// Usage (from demo.ts): explain-dag <basic|timeout|chained|handoff> [run]
// where `run` is a 1-based index (1, 01, "2") defaulting to the first
// snapshotted run in the recipe directory. For handoff, a snapshotted
// run may be named run-claim-NN or run-timeout-NN — this tool picks
// the first in sort order unless a specific index is provided (and
// will need a small tweak if you want to select by mode; easier is to
// run the tool with --raw pointing at the specific run.raw.json).

import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

import { ARTIFACTS_DIR } from "./config.js";
import type { OnchainSnapshot } from "./snapshot.js";
import { parseRecipeName, type RecipeName } from "./recipes/types.js";

interface TraceLogBody {
  ev: string;
  recipe: string;
  name: string;
  block_ts_ms: number;
}

function parseTraceLog(log: string): TraceLogBody | null {
  if (!log.startsWith("trace:")) return null;
  try {
    return JSON.parse(log.slice("trace:".length)) as TraceLogBody;
  } catch {
    return null;
  }
}

interface Placement {
  ev: string;
  role: string;
  blockHeight: number | null;
  name: string;
}

// Resolve a snapshot file for the given recipe + optional run hint.
// Handoff files are named run-{mode}-NN; other recipes use run-NN. If
// runArg is "claim-01" / "timeout-02" that's used verbatim for handoff;
// if it's a number, the first matching run of any mode is chosen.
function resolveSnapshotPath(recipe: RecipeName, runArg: string | undefined): string {
  const dir = join(ARTIFACTS_DIR, `recipe-${recipe}`);
  if (runArg && /^(claim|timeout)-\d+$/.test(runArg)) {
    return join(dir, `run-${runArg}.onchain.json`);
  }
  if (runArg !== undefined) {
    const n = Number(runArg);
    if (!Number.isFinite(n) || n < 1) throw new Error(`invalid run index: ${runArg}`);
    const padded = Math.floor(n).toString().padStart(2, "0");
    // Plain recipes use run-NN; handoff use run-{mode}-NN — try plain
    // first, then fall back to any handoff mode with that index.
    const plain = join(dir, `run-${padded}.onchain.json`);
    if (existsSync(plain)) return plain;
    if (recipe === "handoff") {
      for (const mode of ["claim", "timeout"] as const) {
        const p = join(dir, `run-${mode}-${padded}.onchain.json`);
        if (existsSync(p)) return p;
      }
    }
    throw new Error(`no snapshot for run ${runArg} in ${dir}`);
  }
  // No run specified — pick the first in sort order.
  const candidates = readdirSync(dir)
    .filter((f) => /\.onchain\.json$/.test(f))
    .sort();
  if (candidates.length === 0) throw new Error(`no snapshots in ${dir}`);
  return join(dir, candidates[0]!);
}

function loadSnapshot(
  recipe: RecipeName,
  runArg: string | undefined,
): { snapshot: OnchainSnapshot; path: string } {
  const path = resolveSnapshotPath(recipe, runArg);
  if (!existsSync(path)) throw new Error(`no snapshot at ${path}`);
  return { snapshot: JSON.parse(readFileSync(path, "utf8")) as OnchainSnapshot, path };
}

function scanTraceEvents(snapshot: OnchainSnapshot, recipe: RecipeName): Placement[] {
  const blocksByHash = new Map(Object.entries(snapshot.blocks));
  const placements: Placement[] = [];
  for (const [role, tx] of Object.entries(snapshot.txStatus)) {
    if (!tx) continue;
    for (const outcome of tx.receipts_outcome) {
      for (const log of outcome.outcome.logs) {
        const body = parseTraceLog(log);
        if (!body || body.recipe !== recipe) continue;
        const block = blocksByHash.get(outcome.block_hash);
        placements.push({
          ev: body.ev,
          role,
          blockHeight: block?.header.height ?? null,
          name: body.name,
        });
      }
    }
  }
  return placements;
}

function expectedPlacement(recipe: RecipeName, snapshot: OnchainSnapshot): Record<string, string> {
  if (recipe === "basic") {
    return { recipe_yielded: "yield", recipe_resumed: "resume", recipe_resolved_ok: "yield" };
  }
  if (recipe === "timeout") {
    return { recipe_yielded: "yield", recipe_resolved_err: "yield" };
  }
  if (recipe === "chained") {
    return {
      recipe_yielded: "yield",
      recipe_resumed: "resume",
      recipe_dispatched: "yield",
      recipe_callback_observed: "yield",
      recipe_resolved_ok: "yield",
    };
  }
  // handoff: infer mode from whether a resume tx was snapshotted. Timeout
  // mode snapshots only the yield tx.
  const isTimeout = !snapshot.txStatus.resume;
  if (isTimeout) {
    return {
      recipe_yielded: "yield",
      recipe_resolved_err: "yield",
      handoff_offered: "yield",
      handoff_refunded: "yield",
    };
  }
  return {
    recipe_yielded: "yield",
    recipe_resumed: "resume",
    recipe_resolved_ok: "yield",
    handoff_offered: "yield",
    handoff_released: "yield",
  };
}

function padCell(s: string, width: number): string {
  return s.length >= width ? s : s + " ".repeat(width - s.length);
}

export function explainDag(recipeArg: string | undefined, runArg: string | undefined): void {
  const recipe = parseRecipeName(recipeArg);
  const { snapshot, path } = loadSnapshot(recipe, runArg);
  const runLabel = path.match(/run-([^.]+)\.onchain\.json$/)?.[1] ?? "?";

  process.stdout.write(`recipe: ${recipe}  run: ${runLabel}\n`);
  process.stdout.write(`snapshot: ${path}\n\n`);

  // Tx-role header: hashes + block heights.
  const blocksByHash = new Map(Object.entries(snapshot.blocks));
  for (const [role, tx] of Object.entries(snapshot.txStatus)) {
    if (!tx) {
      process.stdout.write(`${padCell(role + " tx", 10)} (snapshot missing)\n`);
      continue;
    }
    const block = blocksByHash.get(tx.transaction_outcome.block_hash);
    const height = block?.header.height ?? "?";
    const hash = tx.transaction_outcome.id ?? "?";
    process.stdout.write(`${padCell(role + " tx", 10)} ${hash}  block ${height}\n`);
  }
  process.stdout.write("\n");

  // Placements table.
  const placements = scanTraceEvents(snapshot, recipe);
  const expected = expectedPlacement(recipe, snapshot);
  const evWidth = Math.max(
    "event".length,
    ...placements.map((p) => p.ev.length),
    ...Object.keys(expected).map((e) => e.length),
  );
  const roleWidth = Math.max("found in".length, ...placements.map((p) => p.role.length));
  const expWidth = Math.max("expected".length, ...Object.values(expected).map((r) => r.length));

  const sep = `| ${padCell("", evWidth).replace(/ /g, "-")} | ${padCell("", roleWidth).replace(/ /g, "-")} | ${padCell("", expWidth).replace(/ /g, "-")} | ${padCell("", 10).replace(/ /g, "-")} |`;
  process.stdout.write(
    `| ${padCell("event", evWidth)} | ${padCell("found in", roleWidth)} | ${padCell("expected", expWidth)} | ${padCell("block", 10)} |\n`,
  );
  process.stdout.write(sep + "\n");

  const violations: string[] = [];
  // Show all observed placements, grouped per canonical event so the
  // ordering matches a reader's mental model rather than the raw scan.
  const evsInOrder = Object.keys(expected);
  const extras = placements.filter((p) => !evsInOrder.includes(p.ev));
  for (const ev of evsInOrder) {
    const found = placements.find((p) => p.ev === ev);
    const role = found?.role ?? "—";
    const exp = expected[ev] ?? "—";
    const block = found?.blockHeight !== null && found?.blockHeight !== undefined ? String(found.blockHeight) : "—";
    process.stdout.write(
      `| ${padCell(ev, evWidth)} | ${padCell(role, roleWidth)} | ${padCell(exp, expWidth)} | ${padCell(block, 10)} |\n`,
    );
    if (found && found.role !== exp) {
      violations.push(`${ev}: expected in ${exp} tx DAG, found in ${found.role}`);
    }
    if (!found) {
      violations.push(`${ev}: expected in ${exp} tx DAG, not found in any snapshotted tx`);
    }
  }
  for (const extra of extras) {
    process.stdout.write(
      `| ${padCell(extra.ev, evWidth)} | ${padCell(extra.role, roleWidth)} | ${padCell("(unexpected)", expWidth)} | ${padCell(String(extra.blockHeight ?? "—"), 10)} |\n`,
    );
  }

  process.stdout.write("\n");
  if (violations.length === 0) {
    process.stdout.write("DAG-placement invariant: OK\n");
  } else {
    process.stdout.write(`DAG-placement invariant: VIOLATED (${violations.length})\n`);
    for (const v of violations) process.stdout.write(`  - ${v}\n`);
  }
}
