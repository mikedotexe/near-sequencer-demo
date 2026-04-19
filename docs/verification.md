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
cd near-sequencer-demo
(cd scripts && npm install)   # needs Node 18+
NEAR_NETWORK=mainnet ./scripts/demo.sh audit basic
NEAR_NETWORK=mainnet ./scripts/demo.sh audit timeout
NEAR_NETWORK=mainnet ./scripts/demo.sh audit chained
NEAR_NETWORK=mainnet ./scripts/demo.sh audit handoff
```

No `.env` / API key required for path 2 — the auditor prefers the
cached `run-NN.onchain.json` over any RPC fetch (see `snapshotSource`
in [`scripts/src/audit.ts`](../scripts/src/audit.ts)), so the four
commands run with no network access. Each prints a one-line
interpretation per run and exits non-zero on any invariant violation.
Expected output:

```
[audit basic]   (onchain_json) resolved_ok with payload="hello-1"; yield→resume=4b; resume→callback=2b
[audit timeout] (onchain_json) timeout fired after 202 blocks (NEP-519 budget = 200)
[audit handoff] (onchain_json) claim: 10000000000000000000000 yocto → bob.mike.near; yield→resume=6b; yield→settle=8b
...
```

After the auditor runs it rewrites `run-NN.audit.json` in-place. The
committed `run-NN.audit.json` is the reference result — `git diff
artifacts/mainnet/` after re-audit should be empty. `audit.json`
carries no wall-clock timestamps or run-order fields, so comparison
is byte-exact and deterministic.

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
NEAR_NETWORK=mainnet ./scripts/demo.sh audit timeout
NEAR_NETWORK=mainnet ./scripts/demo.sh audit chained
NEAR_NETWORK=mainnet ./scripts/demo.sh audit handoff
```

With no local snapshot, the auditor reconstructs the receipt DAG
from archival RPC using the `tx_hash + signer_id` pair in each
`run-NN.raw.json`, calling the same `snapshotOnChain()` code path
that wrote the snapshot originally. Expected output per run:

```
[audit]   no snapshot at artifacts/mainnet/recipe-basic/run-01.onchain.json; re-fetching from archival RPC...
[audit]   wrote artifacts/mainnet/recipe-basic/run-01.onchain.json (6 blocks, 6 chunks, status=complete)
[audit basic]   (onchain_json) resolved_ok with payload="hello-1"; yield→resume=4b; resume→callback=2b
```

**What to compare.** The reconstructed `run-NN.onchain.json` will
differ from the committed version in exactly two fields:
`snapshotAt` (the auditor stamps `new Date().toISOString()` on each
write) and `latestBlockAtSnapshotHeight` (the chain tip at the
moment of re-fetch). All other bytes — blocks, chunks, receipt
outcomes — are byte-identical to the committed version.

The deterministic comparison surface is `run-NN.audit.json`, which
derives only from receipt content and carries no wall-clock fields:

```sh
git diff artifacts/mainnet/**/run-*.audit.json
# → empty if the re-fetched chain data audits identically
```

This repo ships with this exact check passing — a full `rm *.onchain.json`
+ re-audit against FastNEAR archival leaves zero bytes of diff in
any of the 10 committed `audit.json` files (and two-field drift in
each `onchain.json` as described above). That's the "nothing to
trust" proof: the four invariants derived from freshly-fetched
archival data match the four committed invariant results exactly.
All four invariants must also print `PASS` in the command output.

If you want a rougher onchain-level sanity check,
`jq 'del(.snapshotAt, .latestBlockAtSnapshotHeight)' run-NN.onchain.json`
on both sides and diff the normalized JSON — anything remaining is
real divergence.

**Constraint: archival retention.** FastNEAR's free archival tier
covers the recent past; if you try this long after the commit date,
some receipts may fall out of the archive (the auditor reports
`snapshotStatus.overall = partial` in that case and emits which
block/chunk fetches failed). If retention has expired, fall back to
path 1 or 2, or point the pipeline at a paid archival provider by
setting `RPC_AUDIT=<your-archival-endpoint>` in `.env`.

**Optional: higher rate limits.** The free tier is enough for a
~10-run re-fetch, but if you hit rate limits, create a FastNEAR key at
[dashboard.fastnear.com](https://dashboard.fastnear.com) and set
`FASTNEAR_API_KEY=...` in `.env`. One key works for both RPC and
archival.

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

Three steps. All commands run from the repo root; the only extra
prerequisite beyond path 2's `npm install` is Rust + the wasm32 target
(`rustup target add wasm32-unknown-unknown`).

**1. Build the wasm locally from this commit and hash it.**

```sh
cargo build --release --target wasm32-unknown-unknown -p recipes
shasum -a 256 target/wasm32-unknown-unknown/release/recipes.wasm
# → 891c9bbecbdb14f5fc6f891315ea9004677b5b3bf35aa106164fdd658a8033ff
#   (matches wasmSha256 in artifacts/mainnet/deploys.json)
```

**2. Convert the hex digest to base58 so it's comparable with NEAR's
`code_hash` format.** The repo already has `bs58` vendored via
`scripts/node_modules/near-api-js` — no extra install:

```sh
NODE_PATH=./scripts/node_modules node -e '
  const bs58 = require("bs58"); const m = bs58.default || bs58;
  console.log(m.encode(Buffer.from(process.argv[1], "hex")))
' 891c9bbecbdb14f5fc6f891315ea9004677b5b3bf35aa106164fdd658a8033ff
# → AEEA3kTGzrktu8N2T5pFVr7KBHLekznkPA2SCVev8SVU
```

**3. Fetch the live `code_hash` from mainnet RPC and compare:**

```sh
curl -s https://rpc.mainnet.fastnear.com -H "content-type: application/json" -d '{
  "jsonrpc":"2.0","id":1,"method":"query",
  "params":{"request_type":"view_account","finality":"final","account_id":"recipes.mike.near"}
}' | python3 -c "import sys, json; print(json.load(sys.stdin)['result']['code_hash'])"
# → AEEA3kTGzrktu8N2T5pFVr7KBHLekznkPA2SCVev8SVU
```

Matching bytes = the deployed contract was compiled from this repo's
source at this commit.

**Reproducibility caveat.** Rust + cargo builds are not bit-reproducible
by default across machines — differences in linker, `CARGO_HOME`, build
paths, and toolchain version all perturb the bytes. The deploy
referenced above was built with stable rust + near-sdk 5.26.1 (pinned in
`Cargo.toml`). If the hash doesn't match but the on-chain behavior
does, paths 1/2/3 still confirm the invariants — the wasm check is
additional corroboration, not a prerequisite.

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
