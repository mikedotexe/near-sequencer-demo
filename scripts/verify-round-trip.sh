#!/usr/bin/env bash
# Local self-test of docs/verification.md path 3 (archival re-fetch).
#
# Deletes every `run-NN.onchain.json` under `artifacts/<network>/`, runs
# the auditor (which falls through to FastNEAR archival, reconstructs
# each snapshot, and re-runs the four invariants), then asserts that
# the regenerated `audit.json` files are byte-identical to the committed
# reference. A passing run is the strongest form of path-3 self-
# verification: it confirms the receipt DAGs committed to the repo
# actually match what the chain says today, per the four
# NEP-519 invariants documented in docs/invariants.md.
#
# This is intentionally not part of CI: it hits live archival RPC and
# depends on FastNEAR's retention window, both of which are tolerable
# for an occasional local self-check but unacceptable as a per-PR gate.
#
# Usage: NEAR_NETWORK=mainnet ./scripts/verify-round-trip.sh
#        NEAR_NETWORK=testnet ./scripts/verify-round-trip.sh
# Default: mainnet (the more interesting proof surface).
#
# The script restores deleted onchain.json files from git before exiting
# so a failing run leaves the working tree clean enough to re-commit
# intentionally if needed.

set -euo pipefail

NETWORK="${NEAR_NETWORK:-mainnet}"
REPO_ROOT="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
ARTIFACTS="$REPO_ROOT/artifacts/$NETWORK"

if [[ ! -d "$ARTIFACTS" ]]; then
  echo "verify-round-trip: $ARTIFACTS missing — run the pipeline on $NETWORK first." >&2
  exit 2
fi

# Paranoia guard: refuse to run if there's already uncommitted drift
# in the artifact tree, so we don't mistake prior edits for round-trip
# failure.
if ! git -C "$REPO_ROOT" diff --quiet -- "artifacts/$NETWORK/"; then
  echo "verify-round-trip: uncommitted changes in artifacts/$NETWORK/ — commit or stash them first." >&2
  exit 2
fi

echo "[verify-round-trip] network=$NETWORK"
echo "[verify-round-trip] deleting onchain.json snapshots to force archival re-fetch..."
find "$ARTIFACTS" -name 'run-*.onchain.json' -print -delete | sed 's/^/  rm /'

restore() {
  echo "[verify-round-trip] restoring onchain.json + audit.json from git..."
  git -C "$REPO_ROOT" checkout -- "artifacts/$NETWORK/" || true
}
trap restore EXIT

echo "[verify-round-trip] re-auditing (auditor will re-fetch from archival RPC)..."
for recipe in basic timeout chained handoff; do
  NEAR_NETWORK="$NETWORK" "$REPO_ROOT/scripts/demo.sh" audit "$recipe"
done

echo "[verify-round-trip] asserting audit.json files are byte-identical..."
if git -C "$REPO_ROOT" diff --exit-code -- "artifacts/$NETWORK/"'**'/run-'*'.audit.json; then
  echo "[verify-round-trip] audit.json: byte-identical to committed reference."
else
  echo "[verify-round-trip] FAIL: audit.json drift detected." >&2
  exit 1
fi

# onchain.json must differ only in the two wall-clock fields (snapshotAt,
# latestBlockAtSnapshotHeight). Anything else is real divergence.
echo "[verify-round-trip] asserting onchain.json drift is only wall-clock fields..."
drift_lines=$(git -C "$REPO_ROOT" diff -- "artifacts/$NETWORK/"'**'/run-'*'.onchain.json \
  | grep -E '^[-+][^-+]' \
  | grep -Ev '"snapshotAt":|"latestBlockAtSnapshotHeight":' \
  || true)
if [[ -n "$drift_lines" ]]; then
  echo "[verify-round-trip] FAIL: onchain.json drift outside wall-clock fields:" >&2
  echo "$drift_lines" >&2
  exit 1
fi
echo "[verify-round-trip] onchain.json: drift confined to snapshotAt + latestBlockAtSnapshotHeight (expected)."

echo "[verify-round-trip] PASS — four invariants survive archival re-fetch round-trip on $NETWORK."
