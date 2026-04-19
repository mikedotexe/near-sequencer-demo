# Verification — confirming the four invariants independently

The repository commits two full artifact trees — `artifacts/testnet/` and
`artifacts/mainnet/` — each containing a frozen receipt-DAG snapshot per
run plus the auditor's parsed results. A reader who wants to confirm
the four invariants (DAG-placement, Budget, Atomicity, Shard-placement)
without trusting us has three independent paths, in increasing order
of rigor and effort.

## Path 1 — Eyeball via block explorer (2 min)

Every run's table row in
[`artifacts/mainnet/report.md`](../artifacts/mainnet/report.md)
(and the testnet sibling) carries an explorer link to
[`nearblocks.io`](https://nearblocks.io). nearblocks runs its own
indexer off an independent archival node — if the committed artifacts
ever drifted from real chain state, the explorer would disagree.

What to check once the explorer page loads:

- **Status: Success** on both the yield tx and the resume tx
  (or `timed out` on the timeout runs — that's the expected branch).
- **Receipts tab** shows the receipt tree. The yielded-callback receipt
  appears in the yield-tx's tree, not the resume-tx's — this is
  DAG-placement visible at a glance.
- **Recipe 4 (handoff-claim) only:** the receipts view shows a
  `Transfer` action of `10000000000000000000000` yocto
  (= 0.01 NEAR) to `bob.mike.near`, sibling to the
  `recipe_handoff_resume` function call — Atomicity observable
  end-to-end.
- **Recipe 2 / handoff-timeout:** the `recipe_resolved_err` /
  `handoff_refunded` receipt executes ~200 blocks after the yield tx
  (actually 202 on both networks, which is inside the invariant's
  [200, 205] bound) — Budget observable by subtracting block numbers.

This path trusts nearblocks to be honest but trusts nothing about
this repo.

## Path 2 — Offline machine re-audit from committed snapshots (5 min)

The committed `run-NN.onchain.json` files are full receipt-DAG
snapshots — blocks, chunks, receipt outcomes — captured at run time.
The auditor can re-run the four invariant checks entirely offline
against them:

```sh
git clone https://github.com/mikedotexe/near-sequencer-demo
cd near-sequencer-demo/scripts && npm install && cd ..
NEAR_NETWORK=mainnet ./scripts/demo.sh audit basic
NEAR_NETWORK=mainnet ./scripts/demo.sh audit timeout
NEAR_NETWORK=mainnet ./scripts/demo.sh audit chained
NEAR_NETWORK=mainnet ./scripts/demo.sh audit handoff
```

The auditor prefers the cached `run-NN.onchain.json` over any RPC
fetch (see `snapshotSource` in
[`scripts/src/audit.ts`](../scripts/src/audit.ts)), so the four
commands run without network access. Each prints a one-line
interpretation per run and exits non-zero on any invariant violation.
Expected output:

```
[audit basic]   (onchain_json) resolved_ok with payload="hello-1"; yield→resume=4b; resume→callback=2b
[audit timeout] (onchain_json) timeout fired after 202 blocks (NEP-519 budget = 200)
[audit handoff] (onchain_json) claim: 10000000000000000000000 yocto → bob.mike.near; yield→resume=6b; yield→settle=8b
...
```

The committed `run-NN.audit.json` beside each snapshot is the
reference result — a verifier can `diff` their own audit output
against the committed one. Deterministic.

This path trusts nothing about either network — everything verifiable
from data already in the repo.

## Path 3 — Fully independent re-fetch from archival RPC (10 min)

Path 2 verifies our snapshots are internally consistent, but does
not verify those snapshots match reality. Path 3 does. Delete the
committed snapshots and force the auditor to re-fetch from FastNEAR's
mainnet archival endpoint:

```sh
rm artifacts/mainnet/recipe-*/run-*.onchain.json
NEAR_NETWORK=mainnet ./scripts/demo.sh audit basic
# (and timeout, chained, handoff)
```

With no local snapshot, `snapshotSource` falls through to
`archival-rpc.mainnet.fastnear.com`, reconstructing the receipt DAG
from the `tx_hash + signer_id` pair in each `run-NN.raw.json`. The
new snapshot is written back to the same filename; a `git diff` on
the reconstructed `run-NN.onchain.json` vs. the committed version
should be semantically empty (stable-hashed ordering). Any
divergence = evidence we tampered with the commit.

Constraint: this depends on FastNEAR's archival retention window.
The free tier covers the recent past; if you try this long after the
commit date, receipts may fall out of the archive. In that case use
path 1 or 2, or a paid archival provider.

## Wasm verification — prove the deployed contract matches this repo's source

The per-network [`deploys.json`](../artifacts/mainnet/deploys.json)
captures the sha256 of the exact wasm that was deployed:

```json
{
  "key": "recipes",
  "accountId": "recipes.mike.near",
  "wasmSha256": "891c9bbecbdb14f5fc6f891315ea9004677b5b3bf35aa106164fdd658a8033ff",
  "deployTxHash": "FUKQbEAmHQD8pPAjiEz8S52eFCjrBsjWEaCVkxVcw3bp",
  "initTxHash":   "FUKQbEAmHQD8pPAjiEz8S52eFCjrBsjWEaCVkxVcw3bp"
}
```

(`deployTxHash == initTxHash` because create+deploy+init is a single
atomic tx — see
[`docs/mainnet-readiness.md#secure-init-atomic-createdeployinit`](mainnet-readiness.md#secure-init--atomic-createdeployinit).)

To verify the deployed contract was built from the source in this
repo:

```sh
# 1. Build the wasm locally from this commit.
cargo build --release --target wasm32-unknown-unknown -p recipes

# 2. Hash the resulting wasm.
shasum -a 256 target/wasm32-unknown-unknown/release/recipes.wasm
# → 891c9bbecbdb14f5fc6f891315ea9004677b5b3bf35aa106164fdd658a8033ff

# 3. Compare to the on-chain contract's code_hash. near CLI:
near state recipes.mike.near
# or via RPC directly:
curl -s https://rpc.mainnet.fastnear.com -H "content-type: application/json" -d '{
  "jsonrpc":"2.0","id":1,"method":"view_account",
  "params":{"finality":"final","account_id":"recipes.mike.near"}
}' | jq -r '.result.code_hash'
# → (base58-encoded form of the same 32 bytes)
```

Note: NEAR expresses `code_hash` in base58; `shasum` emits hex. Both
encode the same 32 bytes. A tiny converter:

```sh
python3 -c "import hashlib, base58; \
  print(base58.b58encode(bytes.fromhex('891c9bbecbdb14f5fc6f891315ea9004677b5b3bf35aa106164fdd658a8033ff')).decode())"
```

Matching hashes = the deployed contract was compiled from this repo
at this commit. Note that rust builds are reproducible only with a
fixed toolchain; `rust-toolchain.toml` pins the version.

## What if something doesn't match

If any of the three paths disagrees with the committed artifacts, the
bug is in the repo, not in the chain. Open an issue with:

- Which path (1, 2, or 3) diverged.
- The specific run/recipe.
- A copy of the diff (for path 2/3) or a screenshot (for path 1).

The invariants are protocol-correctness claims — a single divergence
would be a significant finding about either the repo or NEP-519
itself.

## Why three paths

Each path has a different trust model and different failure mode:

| Path | Trusts | Breaks if | Time |
|------|--------|-----------|------|
| 1. Eyeball | nearblocks indexer | indexer wrong *and* our snapshot coincidentally matches the wrong view | 2 min |
| 2. Offline re-audit | nothing external | our snapshots internally fabricated | 5 min |
| 3. Archival re-fetch | FastNEAR archive | archive retention window expires | 10 min |

Combined, the three paths make the claim
"four invariants hold on every run, on both networks" verifiable with
essentially no remaining trust in the repo's good faith.
