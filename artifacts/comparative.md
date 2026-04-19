# NEP-519 recipe book — testnet vs mainnet comparison

The four invariants ([`docs/invariants.md`](../docs/invariants.md))
are protocol-correctness claims about NEP-519's `yield`/`resume`
primitive. They should hold on any NEAR network. This report
shows how they held side-by-side on both testnet (lighter load,
sparse traffic) and mainnet (real validator cohort, real cross-
shard receipt forwarding under the demo's account layout).

## Invariants at a glance

All four invariants hold identically on both testnet and mainnet.

| Invariant | Testnet | Mainnet |
|-----------|---------|---------|
| DAG-placement | **PASS** (40/40) | **PASS** (40/40) |
| Budget (NEP-519 200-block timeout) | **PASS** (2/2) | **PASS** (2/2) |
| Atomicity (Recipe 4) | **PASS** (3/3) | **PASS** (3/3) |
| Shard-placement | **PASS** (13/13) | **PASS** (13/13) |

## Budget invariant — observed-block distribution

NEP-519 specifies a 200-block timeout. The observed upper bound
`[200, 205]` allows for small runtime scheduling overhead on the
yielded-receipt delivery.

| Network | Runs | Observed block counts | Spread |
|---------|------|-----------------------|--------|
| Testnet | 2 | [202, 202] (all=202) | 202 |
| Mainnet | 2 | [202, 202] (all=202) | 202 |

**Interpretation.** Under real mainnet validator load the budget
delta could have widened relative to testnet's sparser traffic.
Both networks observed the same value. The 2-block overshoot past
the nominal 200 is the runtime's scheduling latency on delivering
the callback once the budget elapses; it is deterministic within
the observed window.

## Shard-placement — contract home shard

Each network's `recipes.<master>` account hashes to a single shard
under the current shard layout. NEP-519 callback receipts are
scheduled at yield time against that shard's yielded-receipt queue
and must execute there regardless of which shard the resume tx was
signed from.

| Network | Contract account | Home shard(s) | Callback receipts on home shard |
|---------|------------------|---------------|---------------------------------|
| Testnet | `recipes.mike.testnet` | 4 | 13/13 |
| Mainnet | `recipes.mike.near` | 4 | 13/13 |

**Interpretation.** The specific home shard is a function of the
account name under the current shard layout and is not guaranteed
to match across networks; what the invariant guarantees is that
*wherever* the contract lands, every callback receipt executes
there. The ratio above is the direct evidence.

## Per-recipe drill-down

For per-run tables, explorer links, block-delta breakdowns, and
interpretation text:

- Testnet: [`artifacts/testnet/report.md`](testnet/report.md)
- Mainnet: [`artifacts/mainnet/report.md`](mainnet/report.md)

## How to reproduce

See [`docs/verification.md`](../docs/verification.md) for three
independent-verification paths (explorer eyeball / offline
re-audit / archival re-fetch) plus a wasm-hash cross-check
against the deployed contracts.

## Summary

Dual-network evidence for all four invariants. The claims are protocol-level — that they hold identically under both testnet's lighter load and mainnet's real validator cohort is the central empirical finding of this repo.
