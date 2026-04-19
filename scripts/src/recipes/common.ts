// Shared scaffolding for the four recipe flows (basic, timeout, chained,
// handoff): artifact directory management, snapshot-and-write pass,
// poll helpers.

import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { ARTIFACTS_DIR } from "../config.js";
import { snapshotOnChain, writeOnchainSnapshot, type SnapshotTx } from "../snapshot.js";
import type { RawArtifact, RecipeName } from "./types.js";

export function recipeDir(recipe: RecipeName): string {
  const dir = join(ARTIFACTS_DIR, `recipe-${recipe}`);
  mkdirSync(dir, { recursive: true });
  return dir;
}

export function runSuffix(i: number): string {
  return i.toString().padStart(2, "0");
}

export async function writeRawAndSnapshot(
  raw: RawArtifact,
  txs: SnapshotTx[],
  // Optional filename suffix override; defaults to zero-padded runIndex.
  // Used by handoff to distinguish claim/timeout runs that share a dir
  // but use independent runIndex sequences (otherwise run-01 collides).
  suffixOverride?: string,
): Promise<void> {
  const dir = recipeDir(raw.recipe);
  const suffix = suffixOverride ?? runSuffix(raw.runIndex);
  const rawPath = join(dir, `run-${suffix}.raw.json`);
  writeFileSync(rawPath, JSON.stringify(raw, null, 2));
  // Snapshot inline so each run is durable even if a later run crashes.
  try {
    const snapshot = await snapshotOnChain(txs);
    const onchainPath = join(dir, `run-${suffix}.onchain.json`);
    // (use `suffixOverride` above if provided so the onchain sibling
    // matches the raw filename).
    writeOnchainSnapshot(onchainPath, snapshot);
    process.stderr.write(
      `[run ${raw.recipe}]   snapshotted ${Object.keys(snapshot.blocks).length} blocks, ` +
        `${Object.keys(snapshot.chunks).length} chunks across ${txs.length} txs\n`,
    );
  } catch (e) {
    process.stderr.write(`[run ${raw.recipe}]   snapshot failed: ${(e as Error).message}\n`);
  }
}
