# Verification — confirming the four invariants independently

## What you are verifying

NEAR's default execution model is asynchronous: every transaction
fans out into a receipt DAG, and once all receipts resolve, the tx
is done. A contract cannot pause itself mid-flow and wait for a
signal that doesn't exist yet. The only tools are fire-and-forget
function calls and `Promise.then()` continuations on downstream
receipts whose execution has already started.

[NEP-519](https://github.com/near/NEPs/blob/master/neps/nep-0519.md)
adds a different primitive: `Promise::new_yield` schedules a
callback receipt that sits in a yielded-receipts queue until either
(a) the contract calls `yield_id.resume(payload)` from a later
transaction, or (b) the 200-block budget elapses. In both branches
the same pre-scheduled receipt fires exactly once, with either the
resume payload or a `PromiseError` on the Err arm. The contract
controls the pause.

This repo demonstrates that pattern — **contract-controlled
sequential receipt execution across block boundaries** — with four
recipes, then machine-checks four invariants on every run to prove
it actually works on mainnet. Verifying those four invariants
yourself is verifying, concretely:

- **DAG-placement** — the callback receipt lives in the *yield*
  tx's DAG, not the resume tx's. Proves the runtime is delivering
  payloads to pre-scheduled receipts, not creating new ones on
  resume. (Without this, resume would just be a normal
  cross-contract call and the whole sequencing story collapses.)
- **Budget** — the 200-block timeout fires within the
  spec'd window on mainnet (observed: 202 blocks, every run, both
  networks). Proves the runtime's timer on yielded receipts is
  real and deterministic.
- **Atomicity** (Recipe 4 / handoff) — when resume lands, the
  contract's callback atomically transfers the escrowed value to
  the recipient nominated at yield time. Proves the sequencing
  primitive composes with value transfer: you can use yield/resume
  to escrow and settle, not just to wait.
- **Shard-placement** — the yielded callback executes on the
  contract's home shard regardless of which shard the resume tx
  was signed from. Proves the runtime is routing payloads back to
  where the YieldId was registered. (Cross-shard resume would
  otherwise fracture the sequencing.)

For the contrast with NEAR's other composition patterns — why
`intents.near` uses synchronous batching instead, and what
architectural choice the pause-across-blocks primitive makes
possible — see [`intents-near.md`](intents-near.md). For the full
derivation of each invariant (NEP-519 semantics + observable
signature + code pointer), see [`invariants.md`](invariants.md).

## Three independent paths, in order of rigor

The repository commits two full artifact trees — `artifacts/testnet/`
and `artifacts/mainnet/` — each containing a frozen receipt-DAG
snapshot per run plus the auditor's parsed results. A reader who
wants to confirm the four invariants without trusting us has three
independent paths, in increasing order of rigor and effort.

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

### Automating path 3 as a self-test

[`scripts/verify-round-trip.sh`](../scripts/verify-round-trip.sh)
packages the whole sequence — `rm *.onchain.json`, re-audit, diff-
check, restore — into one command:

```sh
NEAR_NETWORK=mainnet ./scripts/verify-round-trip.sh
```

It refuses to run if `artifacts/<network>/` has uncommitted changes
(so prior local edits can't be mistaken for round-trip failure),
deletes every committed `onchain.json`, re-runs the four audits
forcing archival re-fetch, asserts that every regenerated
`audit.json` is byte-identical to the committed version, and
asserts that the `onchain.json` drift is confined to the two
wall-clock fields (`snapshotAt`, `latestBlockAtSnapshotHeight`).
On exit (success or failure) it restores the committed tree via
`git checkout` so you can re-run cleanly. Use it whenever you want
to confirm that the committed snapshots still match chain reality
— a passing run is the strongest form of path-3 evidence.

Not part of CI: hitting live archival on every PR is inappropriate
(cost + rate limits + retention window makes it an unreliable
gate). It's a local self-check.

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
prerequisite beyond path 2's `npm install` is Rust + the wasm32
target, which the pinned `rust-toolchain.toml` will install on first
`cargo build`.

**1. Build the wasm locally from this commit and hash it.**

```sh
cargo build --release --target wasm32-unknown-unknown -p recipes
shasum -a 256 target/wasm32-unknown-unknown/release/recipes.wasm
# → 6816f8c5025093a6e48eeec1173270f188d7e5dba46c829e88e7b7ccd0f05c47
#   (reproducible under rust-toolchain.toml's pinned stable channel)
```

**2. Convert the hex digest to base58 so it's comparable with NEAR's
`code_hash` format.** The repo already has `bs58` vendored via
`scripts/node_modules/near-api-js` — no extra install:

```sh
NODE_PATH=./scripts/node_modules node -e '
  const bs58 = require("bs58"); const m = bs58.default || bs58;
  console.log(m.encode(Buffer.from(process.argv[1], "hex")))
' 6816f8c5025093a6e48eeec1173270f188d7e5dba46c829e88e7b7ccd0f05c47
```

**3. Fetch the live `code_hash` from mainnet RPC:**

```sh
curl -s https://rpc.mainnet.fastnear.com -H "content-type: application/json" -d '{
  "jsonrpc":"2.0","id":1,"method":"query",
  "params":{"request_type":"view_account","finality":"final","account_id":"recipes.mike.near"}
}' | python3 -c "import sys, json; print(json.load(sys.stdin)['result']['code_hash'])"
# → AEEA3kTGzrktu8N2T5pFVr7KBHLekznkPA2SCVev8SVU
```

**What to expect.** The hash printed in step 2 is
`81KiafiZRf3xU56FgJt29J3U4d6eaBj4jbneqrDj8x5k` (the base58 of
`6816f8c5…`), while the on-chain `code_hash` at step 3 is
`AEEA3kTGzrktu8N2T5pFVr7KBHLekznkPA2SCVev8SVU`
(the base58 of `891c9bbe…`). These will not match —
[`deploys.json`](../artifacts/mainnet/deploys.json) records
`wasmSha256: 891c9bbe…` as the hash of the wasm that was uploaded to
`recipes.mike.near` when this repo was first deployed to mainnet;
that upload happened before `rust-toolchain.toml` pinned the
toolchain, on whatever rustup default was active at the time
(nightly). A fresh build under the pin is its own reproducible
artifact going forward; it isn't expected to match a pre-pin
deploy's bytes.

**Using the wasm hash anyway.** The check that IS repeatable today:
two contributors both running `cargo build` under this commit's
`rust-toolchain.toml` will produce byte-identical wasm (`6816f8c5…`),
confirming the source-to-artifact relationship is deterministic for
everyone who builds from here forward. If you want to know "does the
on-chain contract behave like this source does," paths 1/2/3 above
already answer that — the four invariants are the load-bearing
proof surface, and the wasm check is corroborative only.

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

## What a green verification proves

If all three paths complete cleanly — or even just path 2 — you have
confirmed, on real NEAR chain data, that:

1. A NEAR contract scheduled a callback receipt at block `N`, then
   its transaction completed and left that receipt pending.
2. Up to 200 blocks later, either a separate resume transaction
   delivered a payload to the pre-scheduled receipt, or the runtime
   itself delivered a `PromiseError` when the budget expired.
3. Either way, the callback fired exactly once, emitted its trace
   events into the *original* yield tx's DAG, and (for Recipe 4)
   atomically moved value to the recipient bound at yield time.
4. Every callback executed on the recipes contract's home shard,
   regardless of which shard the resume transaction was signed on.

That sequence — *pause, wait, resume, act* — is not expressible with
`Promise.then()` callbacks or with synchronous batching (the pattern
`intents.near` uses; see [`intents-near.md`](intents-near.md)). It
is the defining capability of NEP-519, and the four PASSing
invariants on [`../artifacts/comparative.md`](../artifacts/comparative.md)
are the proof it works as specified, on the real chain, under real
validator load.

Concretely, a green run means NEAR mainnet's runtime is honoring
the contract's request to sequence its own receipt execution across
block boundaries, and this repo's four machine-checked invariants
are the place you can see that with bytes-on-disk evidence instead
of taking anyone's word for it.
