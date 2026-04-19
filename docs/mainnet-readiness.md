# Mainnet readiness

This runbook walks through deploying the recipe book on NEAR mainnet
— the stronger empirical evidence context. The four invariants
(`DAG-placement`, `Budget`, `Atomicity`, `Shard-placement`) are
protocol-correctness claims, so they should hold on any NEAR network;
mainnet gives them a second data point under real validator load and
real cross-shard receipt forwarding.

**Scope.** Everything below assumes the code changes through M1 are
in (shard-placement invariant + `cmdClean` chain-id guard). No
additional contract code is needed for mainnet deploy; the pipeline
is already network-agnostic via `NEAR_NETWORK=testnet|mainnet`.

## Expected cost

~0.5–1 NEAR total for the bootstrap + the same 10-run mix we use on
testnet (3 basic + 1 timeout + 3 chained + 2 handoff-claim + 1
handoff-timeout):

| Item | Cost |
|------|------|
| Sub-account creation (`recipes.*`, `recipes-counter.*`, `bob.*`) | ~0.3 NEAR (3 × ~0.1 NEAR min balance) |
| Gas across ~20 broadcast txs | ~0.1 NEAR |
| Handoff deposits (3 runs × `HANDOFF_AMOUNT_YOCTO`) | 0.03 NEAR at the 0.01 NEAR/handoff default |
| Slack for retries / fees / redeploy | ~0.1 NEAR |
| **Total** | **~0.5–1 NEAR** |

Handoff deposits are recovered in full (claim path lands on Bob,
timeout path refunds to the signer), so the economically consumed
amount is just gas + storage.

## Pre-flight checklist

Do all of these **before** broadcasting anything on mainnet.

1. **Credentials.** Confirm
   `~/.near-credentials/mainnet/<master>.near.json` exists and
   contains a working key for the master account. The scripts load
   from this standard near-api-js location via
   `keyStores.UnencryptedFileSystemKeyStore(CREDENTIALS_DIR)`.

2. **Master balance.** ≥ 1 NEAR recommended, 0.5 NEAR minimum. Check
   with:

   ```sh
   NEAR_NETWORK=mainnet ./scripts/demo.sh check
   ```

   `check` also validates the RPC chain_id (via
   `assertChainIdMatches`) and that credentials load cleanly — a
   green `check` is the prerequisite for every subsequent mainnet
   step.

3. **Archival RPC retention.** FastNEAR's mainnet archival endpoint
   (`archival-rpc.mainnet.fastnear.com`) is used for snapshot
   fetches. The free tier's retention window should be verified
   empirically on the first capture — if it's shorter than the
   testnet window and a fresh capture returns partial snapshots
   (`snapshotStatus.overall = partial` in `run-NN.onchain.json`),
   either re-run the pipeline within the retention window or switch
   to a paid tier. Record the observed retention in this doc once
   known.

4. **Guard flag semantics.** `scripts/demo.sh clean` requires
   `--i-know-this-is-mainnet` AND passes `assertChainIdMatches()`
   before destroying accounts. Without the flag, it refuses. With
   the flag but a misconfigured RPC, the chain-id guard fires and
   refuses. Both safety rails must succeed for a destructive action
   to proceed.

## Bootstrap sequence

Run these in order. Each command must exit 0 before proceeding.

```sh
# 1. Verify the chain-id guard, credentials, and balance.
NEAR_NETWORK=mainnet ./scripts/demo.sh check

# 2. Build the two wasms (network-agnostic).
./scripts/demo.sh build

# 3. Deploy: creates recipes.<master>, recipes-counter.<master>,
#    bob.<master>; deploys the recipes + counter wasms; initializes.
#    Soft-gates with a 3-second wait while printing the target
#    accounts — read the list, confirm it matches your master, then
#    let it run.
NEAR_NETWORK=mainnet ./scripts/demo.sh deploy

# 4. Smoke test: one basic recipe end-to-end. Verifies the signing,
#    snapshot, audit, and invariant pipeline work on mainnet before
#    we spend more NEAR on the full mix.
NEAR_NETWORK=mainnet ./scripts/demo.sh run basic --repeat 1
NEAR_NETWORK=mainnet ./scripts/demo.sh audit basic

# 5. Only if smoke is clean (exit 0, four invariants hold on run-01):
#    run the full 10-run mix. Takes ~10 minutes total (two timeout
#    runs wait ~4 min each for the 200-block budget).
NEAR_NETWORK=mainnet ./scripts/demo.sh run basic --repeat 3
NEAR_NETWORK=mainnet ./scripts/demo.sh run chained --repeat 3
NEAR_NETWORK=mainnet ./scripts/demo.sh run timeout --repeat 1
NEAR_NETWORK=mainnet ./scripts/demo.sh run handoff --mode claim --repeat 2
NEAR_NETWORK=mainnet ./scripts/demo.sh run handoff --mode timeout --repeat 1

# 6. Audit + aggregate + report.
for r in basic timeout chained handoff; do
  NEAR_NETWORK=mainnet ./scripts/demo.sh audit "$r"
done
NEAR_NETWORK=mainnet ./scripts/demo.sh aggregate
NEAR_NETWORK=mainnet ./scripts/demo.sh report
NEAR_NETWORK=mainnet ./scripts/demo.sh translate
```

Alternatively, steps 5–6 collapse to
`NEAR_NETWORK=mainnet ./scripts/demo.sh all`, which runs the same
sequence without intermediate confirmations — use only after the
smoke test is clean.

## Verification — what "done" looks like

- `artifacts/mainnet/` exists with four recipe directories mirroring
  the testnet layout.
- `artifacts/mainnet/report.md` shows four PASS invariant lines in
  the "Invariants at a glance" header:
  - `- DAG-placement: **PASS**`
  - `- Budget (NEP-519 200-block timeout): **PASS**`
  - `- Atomicity (Recipe 4): **PASS**`
  - `- Shard-placement: **PASS**` (on whichever shards the mainnet
    accounts landed on)
- Budget observed-blocks values can be compared with testnet's to
  see whether mainnet congestion widens the `[200, 205]` window
  (the bounds code-wise stay constant; the *observed* distribution
  is the interesting mainnet-vs-testnet data point).
- `nearblocks.io` explorer links in the report resolve to live
  mainnet txs, independently verifying every claim.

## State hygiene on `recipes.<master>`

The contract's `yields: BTreeMap<String, YieldId>` and
`handoffs: BTreeMap<String, HandoffMeta>` maps are where state
accumulates. For the demo's own usage, they stay empty-ish at
steady state because every yield path pairs with a cleanup:

| Recipe | Yield inserts | Cleaned up by |
|--------|---------------|---------------|
| Basic | `yields["basic:<name>"]` | `recipe_basic_resume` via `self.yields.remove(&key)` before `yield_id.resume()` |
| Timeout | `yields["timeout:<name>"]` | `on_timeout_resumed` via `self.yields.remove(&key)` at callback fire (same logic handles both Ok and Err paths) |
| Chained | `yields["chained:<name>"]` | `recipe_chained_resume` via `self.yields.remove(&key)` |
| Handoff (claim mode) | `handoffs["handoff:<name>"]` | `recipe_handoff_resume` via `self.handoffs.remove(&key)` |
| Handoff (timeout mode) | `handoffs["handoff:<name>"]` | `on_handoff_resumed` via `self.handoffs.remove(&key)` at callback fire |

**Per-run net state delta: 0.** A 10-run capture, start to finish,
leaves both maps empty.

### Secure init — atomic create+deploy+init

First-time deploys of the recipes and counter contracts use a single
atomic transaction signed by the master, with five actions in order:
`CreateAccount`, `Transfer` (funding), `AddKey` (full-access key for
our generated keypair), `DeployContract` (wasm upload), and
`FunctionCall("new", {owner_id: MASTER_ACCOUNT_ID})`. Implementation:
[`scripts/src/accounts.ts`](../scripts/src/accounts.ts)
`atomicCreateDeployInit`.

The batch closes the front-running window that would otherwise exist
between a separate `deployContract` tx and a following `functionCall("new", ...)`
tx. In the naive two-tx pattern, an attacker who sees the `deployContract`
land could race ahead with `functionCall("new", {owner_id: "attacker.near"})`
before the legitimate init lands — capturing ownership of a contract
the demo just deployed. With the atomic pattern, `CreateAccount`,
`DeployContract`, and the init `FunctionCall` either all succeed
together or none do; there's no observable state between steps to
race against, because the account literally doesn't exist until the
whole tx lands.

Re-deploys (account exists with contract already) skip the init and
just upload new wasm via `account.deployContract`; NEAR preserves
existing state, `#[init]` isn't re-run, and the original `owner_id`
binding is preserved. An account that exists without a contract —
the rare "partial prior deploy" case — causes a loud error prompting
`clean` + retry rather than silently half-initializing.

### External-abuse protection (owner-gated yields)

The four `recipe_*_yield` methods are gated by an `owner_id` bound
at `new(owner_id)` init time. `self.assert_owner()` at the top of
each yield method fires
`require!(env::predecessor_account_id() == self.owner_id, ...)`, so
only the owner (the demo's master account —
`mike.testnet` / `mike.near` depending on network) can enter the
yield path on this contract. Contract source:
[`contracts/recipes/src/lib.rs`](../contracts/recipes/src/lib.rs)
`fn assert_owner`. The init wiring in
[`scripts/src/accounts.ts`](../scripts/src/accounts.ts) passes
`owner_id: MASTER_ACCOUNT_ID` to the recipes contract's `new` call.

Resume methods stay permissionless — Recipe 4's
`recipe_handoff_resume` in particular is *supposed* to be callable
by anyone (it's the "anyone can pull the trigger" teaching claim).
The gate is on the write side (state mutation via yields) only.

Without this gate, a mainnet spammer could call
`recipe_basic_yield("spam-1")`, `recipe_basic_yield("spam-2")`,
etc., and — because `on_basic_resumed` / `on_chained_resumed` emit
their trace logs on the Err arm without calling
`self.yields.remove()` on timeout — leak ~40 bytes of state per
orphan entry. With the 3 NEAR per-contract initial balance (covering
~100KB per NEAR of NEAR storage at the current protocol rate), the
ceiling would be roughly 7M spam entries before new state is
rejected. Owner-gating the yield methods eliminates that vector
entirely at the contract boundary.

### Existing testnet deploy

The live testnet contract at `recipes.mike.testnet` was deployed
before the owner-gate landed. Its state layout predates the
`owner_id` field, so a simple re-deploy of the new wasm would fail
to deserialize state. Options:

1. **Leave it.** The committed testnet artifacts were generated
   against the old contract and remain valid proof-of-run. The
   invariants are protocol-level claims and hold identically on
   both contract versions. Readers verifying via the committed
   report.md don't observe any difference.
2. **Clean + redeploy testnet.**
   `NEAR_NETWORK=testnet ./scripts/demo.sh clean --i-know-this-is-testnet`
   followed by `./scripts/demo.sh deploy` gives a fresh owner-gated
   testnet contract. Regenerating artifacts (`./scripts/demo.sh all`)
   would replace the committed ones with fresh captures.

Either is acceptable; the mainnet deploy (M3 below) uses the
owner-gated version from the start either way.

## What's next after a clean capture

With `artifacts/mainnet/` committed, the repo has dual-network
evidence for all four invariants. A follow-up tranche can then add a
comparative `artifacts/comparative.md` surfacing testnet-vs-mainnet
side-by-side: observed Budget variance, which shards the four
accounts landed on, PASS status per (invariant × network). That
comparison is the strongest empirical pitch the repo can make — the
claims are protocol-level, and they hold on both a sparse testnet
and a real-load mainnet.
