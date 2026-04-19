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

### External-abuse risk

Recipes 1–3 are permissionless by design — it's part of the teaching
claim that anyone can yield. On mainnet, a spammer could call
`recipe_basic_yield("spam-1")`, `recipe_basic_yield("spam-2")`, etc.
without ever resuming. Each of those yields also pairs with a
200-block timeout callback that would clean up via
`on_basic_resumed`'s Err arm — **but** `on_basic_resumed` and
`on_chained_resumed` don't currently remove the key on the Err path
(they only emit `recipe_resolved_err`). Only `on_timeout_resumed`
and `on_handoff_resumed` clean up unconditionally.

Consequence: a spam flood on basic/chained would leak ~40 bytes of
state per yielded entry. At the `recipes.<master>` contract's
3 NEAR initial balance (covering ~100KB per NEAR of NEAR storage
at the current protocol rate), that's headroom for roughly 7M spam
entries before the contract hits its storage ceiling and stops
accepting new state.

**Mitigation options (none required for the 10-run capture):**

1. **Accept the risk.** The 10-run capture never exercises the abuse
   path; state returns to empty. If mainnet traffic on the demo
   contract ever grows beyond that, revisit.
2. **Add unconditional cleanup to `on_basic_resumed` /
   `on_chained_resumed`.** One line each at the top of the callback:
   `self.yields.remove(&format!("basic:{name}"));` — same pattern
   `on_timeout_resumed` uses today. Preserves the permissionless
   semantics while closing the leak.
3. **Add access control.** `require!(env::predecessor_account_id() ==
   env::current_account_id() || env::predecessor_account_id() ==
   Self::owner())` on yield methods. Breaks the "permissionless"
   teaching claim so not ideal, but is the most defensive option.

Option 2 is the cleanest incremental hardening and would be a small
follow-up commit if the demo ever accumulates external usage. For
the initial mainnet capture, option 1 (accept + monitor) is
sufficient.

## What's next after a clean capture

With `artifacts/mainnet/` committed, the repo has dual-network
evidence for all four invariants. A follow-up tranche can then add a
comparative `artifacts/comparative.md` surfacing testnet-vs-mainnet
side-by-side: observed Budget variance, which shards the four
accounts landed on, PASS status per (invariant × network). That
comparison is the strongest empirical pitch the repo can make — the
claims are protocol-level, and they hold on both a sparse testnet
and a real-load mainnet.
