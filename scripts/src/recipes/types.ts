// Shared types for per-recipe flows and their snapshotted artifacts.
//
// Each recipe run produces:
//   artifacts/<network>/recipe-<name>/run-NN.raw.json      — tx hashes + timing
//   artifacts/<network>/recipe-<name>/run-NN.onchain.json  — tx DAGs + blocks + chunks
//   artifacts/<network>/recipe-<name>/run-NN.audit.json    — parsed lifecycle summary

export type RecipeName = "basic" | "timeout" | "chained" | "handoff";

export const RECIPE_NAMES: readonly RecipeName[] = [
  "basic",
  "timeout",
  "chained",
  "handoff",
] as const;

export function parseRecipeName(s: string | undefined): RecipeName {
  if (s !== "basic" && s !== "timeout" && s !== "chained" && s !== "handoff") {
    throw new Error(`invalid recipe: ${s}. must be basic, timeout, chained, or handoff`);
  }
  return s;
}

interface RawArtifactBase {
  recipe: RecipeName;
  runIndex: number;
  // Human-readable name passed to the contract (`recipe_*_yield(name)`).
  // Also used in the storage key `"recipe:name"` inside the recipes contract.
  name: string;
  signer: string;
  started: string;
  finished: string | null;
}

export interface RawBasicArtifact extends RawArtifactBase {
  recipe: "basic";
  yieldTxHash: string;
  resumeTxHash: string;
  resumePayload: string;
}

export interface RawTimeoutArtifact extends RawArtifactBase {
  recipe: "timeout";
  yieldTxHash: string;
  // Block height at which the yield tx itself executed (needed for the
  // audit's block-scan fallback to locate the timeout callback receipt).
  yieldBlockHeight: number | null;
}

export interface RawChainedArtifact extends RawArtifactBase {
  recipe: "chained";
  counterId: string;
  delta: number;
  yieldTxHash: string;
  resumeTxHash: string;
}

// Atomic handoff (Recipe 4). Two modes snapshot the two lifecycles on
// one contract shape:
//   - "claim":   Alice yields + attaches NEAR; Bob resumes → transfer to Bob
//   - "timeout": Alice yields; no resume; ~200 blocks later refund to Alice
// The `signer` on a handoff artifact is always Alice (she signs yield).
// `recipient` names Bob (the account the contract will/would pay on claim).
// `claimSigner` is Bob's account id when mode=claim; null when mode=timeout.
export interface RawHandoffArtifact extends RawArtifactBase {
  recipe: "handoff";
  mode: "claim" | "timeout";
  recipient: string;
  amountYocto: string;
  yieldTxHash: string;
  // Present when mode="claim"; null when mode="timeout" (no resume tx).
  resumeTxHash: string | null;
  claimSigner: string | null;
  // Yield-tx block height snapshotted for later block-delta analysis
  // (used by the timeout-mode audit the same way the timeout recipe uses it).
  yieldBlockHeight: number | null;
}

export type RawArtifact =
  | RawBasicArtifact
  | RawTimeoutArtifact
  | RawChainedArtifact
  | RawHandoffArtifact;

export function rawArtifactTxHashes(raw: RawArtifact): Array<{ role: string; hash: string }> {
  switch (raw.recipe) {
    case "basic":
      return [
        { role: "yield", hash: raw.yieldTxHash },
        { role: "resume", hash: raw.resumeTxHash },
      ];
    case "timeout":
      return [{ role: "yield", hash: raw.yieldTxHash }];
    case "chained":
      return [
        { role: "yield", hash: raw.yieldTxHash },
        { role: "resume", hash: raw.resumeTxHash },
      ];
    case "handoff": {
      const rows: Array<{ role: string; hash: string }> = [
        { role: "yield", hash: raw.yieldTxHash },
      ];
      if (raw.resumeTxHash) rows.push({ role: "resume", hash: raw.resumeTxHash });
      return rows;
    }
  }
}
