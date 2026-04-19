// Bridges the snapshot pipeline (artifacts/<network>/recipe-*/run-NN.raw.json)
// to the Manim viz timelines (viz/data/recipe-*-live-NN.json) by invoking
// the existing `viz/scripts/onchain-to-timeline.mjs` translator per
// snapshotted run. Keeping this in TS (rather than a shell loop) lets
// `demo.sh all` chain it after the report step without bash glue.

import { spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

import { ARTIFACTS_DIR, REPO_ROOT } from "./config.js";
import { RECIPE_NAMES, type RawArtifact, type RecipeName } from "./recipes/types.js";

export type RunFilter = "all" | "latest" | number;

export function parseRunFilter(args: string[]): RunFilter {
  const idx = args.indexOf("--run");
  if (idx === -1) return "all";
  const val = args[idx + 1];
  if (val === "latest" || val === "all") return val;
  const n = Number(val);
  if (!Number.isFinite(n) || n < 1) throw new Error(`invalid --run value: ${val}`);
  return Math.floor(n);
}

// Highest-numbered suffix per "key" (either "NN" for single-mode recipes or
// "claim-NN" / "timeout-NN" for handoff). Returns one entry per key.
function pickLatest(entries: string[], keyOf: (f: string) => string | null): string[] {
  const byKey = new Map<string, string>();
  for (const e of entries) {
    const k = keyOf(e);
    if (k === null) continue;
    const prev = byKey.get(k);
    if (!prev || e.localeCompare(prev) > 0) byKey.set(k, e);
  }
  return [...byKey.values()];
}

function livenameFor(raw: RawArtifact): string {
  const idx = raw.runIndex.toString().padStart(2, "0");
  if (raw.recipe === "handoff") return `recipe-handoff-${raw.mode}-live-${idx}.json`;
  return `recipe-${raw.recipe}-live-${idx}.json`;
}

export interface TranslateOptions {
  recipes?: readonly RecipeName[];
  run?: RunFilter;
  translatorScript?: string; // override for testing
}

export function translate(opts: TranslateOptions = {}): { generated: string[] } {
  const recipes = opts.recipes ?? RECIPE_NAMES;
  const run = opts.run ?? "all";
  const translator =
    opts.translatorScript ?? join(REPO_ROOT, "viz", "scripts", "onchain-to-timeline.mjs");
  const outDir = join(REPO_ROOT, "viz", "data");
  mkdirSync(outDir, { recursive: true });

  const generated: string[] = [];
  for (const recipe of recipes) {
    const dir = join(ARTIFACTS_DIR, `recipe-${recipe}`);
    let entries: string[];
    try {
      entries = readdirSync(dir)
        .filter((f) => f.endsWith(".raw.json"))
        .sort();
    } catch {
      process.stderr.write(`[translate] ${recipe}: no snapshotted runs in ${dir}, skipping\n`);
      continue;
    }
    if (entries.length === 0) {
      process.stderr.write(`[translate] ${recipe}: no snapshotted runs, skipping\n`);
      continue;
    }

    if (run === "latest") {
      // For handoff, "latest" means highest N per mode (one claim, one timeout).
      // For single-mode recipes, it means the highest N overall.
      entries =
        recipe === "handoff"
          ? pickLatest(entries, (f) => {
              const m = f.match(/^run-(claim|timeout)-\d+\.raw\.json$/);
              return m ? m[1]! : null;
            })
          : pickLatest(entries, () => recipe);
    } else if (typeof run === "number") {
      const suffix = run.toString().padStart(2, "0");
      entries = entries.filter((e) => e.endsWith(`-${suffix}.raw.json`));
      if (entries.length === 0) {
        process.stderr.write(`[translate] ${recipe}: no run matching ${suffix}, skipping\n`);
        continue;
      }
    }

    for (const entry of entries) {
      const rawPath = join(dir, entry);
      const raw = JSON.parse(readFileSync(rawPath, "utf8")) as RawArtifact;
      if (raw.recipe !== recipe) continue;
      const outName = livenameFor(raw);
      const outPath = join(outDir, outName);
      process.stderr.write(`[translate] ${recipe} ${entry} -> viz/data/${outName}\n`);
      const result = spawnSync(translator, ["--raw", rawPath, "--out", outPath], {
        stdio: "inherit",
      });
      if (result.status !== 0) {
        throw new Error(
          `translator failed for ${rawPath} (exit ${result.status ?? "signal"})`,
        );
      }
      generated.push(outPath);
    }
  }
  return { generated };
}
