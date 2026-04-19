# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this repo is

A compact, visual recipe book for NEAR's NEP-519 yield/resume primitive.
Two contracts (`recipes` + canonical `counter`) plus one non-contract
participant (`bob` for Recipe 4), four recipe method groups (basic /
timeout / chained / handoff), a scripts pipeline that broadcasts them
and snapshots receipt DAGs, and Manim scenes per recipe. Verified on
testnet; mainnet support is first-class — see `docs/mainnet-readiness.md`
for the bootstrap runbook. Not a thesis demo.

If you catch yourself writing about "silent value," "dishonest router,"
"truthful resolution surface," or "three-flow proof matrix," stop —
that was the previous framing of this repo, which was retired. See the
README for the current shape.

## Build and test

Cargo workspace of two `cdylib`+`rlib` NEAR contracts (near-sdk 5.26.1,
edition 2021). Release profile is tuned for wasm size (`opt-level = "z"`,
`lto = true`, `panic = "abort"`). `rlib` is there so `cargo test` can
link against the contract code.

Canonical checks (wasm build, unit tests, TS typecheck):

- `cargo build --release --target wasm32-unknown-unknown`
- `cargo test --workspace`
- `./scripts/node_modules/.bin/tsc --noEmit -p scripts/tsconfig.json`

Per-contract build: `cargo build --release --target wasm32-unknown-unknown -p recipes`
(or `-p counter`).

Check one test by name: `cargo test -p recipes basic_yield_records_key_in_map`.

Note on `cargo build --workspace` (no `--target` flag): near-sdk has a
guard that rejects host-target compilation of contract crates with "Use
`cargo near build` instead of `cargo build`". This only affects plain
`cargo build` without a target; `cargo test` is the correct entry point
for host builds.

## Architecture

### `recipes` contract

Four method groups. Recipes 1–3 share `yields: BTreeMap<String, YieldId>`;
Recipe 4 (handoff) has its own `handoffs: BTreeMap<String, HandoffMeta>`
because it carries access-control metadata (the nominated recipient).
Storage keys use `"{recipe}:{name}"` in both maps.

Per-recipe public API. The four `recipe_*_yield` methods are gated
by an owner check (`self.assert_owner()`) — `owner_id` is bound at
init time and stored on the contract. Resume methods stay
permissionless so Recipe 4's "anyone can pull the trigger" teaching
claim still holds. The owner gate closes the mainnet state-abuse
vector where a spammer could call `recipe_basic_yield("spam-1")`,
never resume, and leak ~40 bytes of state per orphan entry. See
`docs/mainnet-readiness.md#state-hygiene-on-recipesmaster` for the
full analysis.

- `recipe_basic_yield(name) -> Promise` / `recipe_basic_resume(name, payload)`
- `recipe_timeout_yield(name) -> Promise` (no paired resume)
- `recipe_chained_yield(name, counter_id) -> Promise` /
  `recipe_chained_resume(name, delta)`
- `recipe_handoff_yield(name, to) -> Promise` (`#[payable]`) /
  `recipe_handoff_resume(name)` — resume is permissionless; anyone can
  pull the trigger, and the funds flow to the `to` stored at yield
  time (resumer can't redirect them). Callback args carry
  `from/to/amount` so the callback does the transfer without a state
  lookup; `HandoffMeta` in storage exists solely to look up the
  YieldId on resume. Access control would be one line
  (`require!(env::predecessor_account_id() == meta.to, ...)`) but the
  demo keeps resume permissionless to sidestep a testnet tx-ordering
  race with independent signers (see point 3 below) and focus on the
  atomic value-transfer story.

Callbacks are `#[private]` (only callable via the yield/callback path).

### Gas budgets

- `GAS_YIELD_CALLBACK`: 150 Tgas — prepaid at yield time, covers the
  callback's own work plus (for Recipe 3) downstream dispatch + observe.
- `GAS_COUNTER_CALL`: 30 Tgas — gas on the counter.increment/decrement call.
- `GAS_OBSERVE_CALLBACK`: 30 Tgas — gas reserved for on_counter_observed.

### Cross-tx yield mechanics

Two things worth internalizing before editing recipes code:

1. **The yielded callback receipt lives in the YIELD tx's DAG, not
   the resume tx's.** `Promise::new_yield` schedules a callback receipt
   at yield time. `yield_id.resume(...)` delivers a payload to that
   already-scheduled receipt. The 200-block timeout path is the same —
   the runtime delivers `PromiseError` to the receipt already in the
   DAG. So every trace event emitted by callback code
   (`recipe_resolved_{ok,err}`, `recipe_dispatched`,
   `recipe_callback_observed`, `handoff_released`, `handoff_refunded`)
   appears on a receipt_outcome inside the YIELD tx's
   `receipts_outcome`, not the resume tx's. Audit and translator both
   walk all snapshotted tx DAGs rather than assuming a role.

   This is the first of four machine-checked invariants —
   DAG-placement (above), Budget (NEP-519 200-block timeout empirically
   holds), Atomicity (Recipe 4's Transfer receipt matches recipient +
   amount + succeeded), and Shard-placement (every callback-emitting
   receipt executes on the contract's home shard via
   `outcome.executor_id == contract`, the directly observable form of
   NEAR's shard-per-receiver semantics). Canonical derivations in
   `docs/invariants.md`; per-run check sites in
   `scripts/src/audit.ts:{computeDagPlacement,checkBudget,checkAtomicity,computeShardPlacement}`;
   per-recipe roll-ups in `scripts/src/aggregate.ts:{computeDagInvariant,
   computeBudgetInvariant,computeAtomicityInvariant,computeShardInvariant}`;
   unit tests in `scripts/test/invariants.test.ts`. A violation prints a
   loud `!!` stderr line from audit and exits non-zero.

2. **`testing_env!` wipes registered YieldIds.** Each mock VM reset
   throws away registered yields, so a unit test cannot drive yield +
   resume end-to-end inside the mock. Unit tests only verify local
   state changes on yield and synthetic callback-result branches. End-
   to-end behavior is verified by `scripts/demo.sh` on testnet.

3. **Alice signs both yield and resume in Recipe 4.** Bob is on stage
   as the nominated recipient in the contract's callback-args (and
   accordingly the transfer lands on him), but the *resume* tx is
   signed by Alice. An earlier version had Bob sign the resume to
   demonstrate access control, but testnet's tx ordering between two
   independent signers (Alice's yield, then Bob's resume) sometimes
   raced — Bob's tx could see stale state and panic with "no handoff
   found for this name." Alice signing both preserves the economic
   demo (value actually moves to Bob at the expected block distance)
   and keeps the flow simple; access control is a one-liner add-back
   if the race pattern gets fixed upstream.

### Trace events

Every observable moment emits a JSON log line prefixed `trace:`:

| event | emitted from | carries |
|---|---|---|
| `recipe_yielded` | yield method | `name` |
| `recipe_resumed` | resume method | `name`, `payload` |
| `recipe_dispatched` | `on_chained_resumed` | `name`, `target`, `method` |
| `recipe_callback_observed` | `on_counter_observed` | `name`, `value` |
| `recipe_resolved_ok` | any `on_*_resumed` (Ok arm) | `name`, `outcome` |
| `recipe_resolved_err` | any `on_*_resumed` (Err arm) | `name`, `reason` |
| `handoff_offered` | `recipe_handoff_yield` | `name`, `from`, `to`, `amount` |
| `handoff_released` | `on_handoff_resumed` (Ok) | `name`, `to`, `amount` |
| `handoff_refunded` | `on_handoff_resumed` (Err/timeout) | `name`, `refunded_to`, `amount` |

Handoff-specific events are emitted *alongside* the generic
`recipe_yielded` / `recipe_resolved_{ok,err}` so the DAG-placement
audit invariant keeps working on the same vocabulary. The extra events
carry the amount/accounts that the generic events don't have fields for.

The `TraceEvent` enum in `contracts/recipes/src/lib.rs`, the trace
parser in `scripts/src/audit.ts`, and the translator in
`viz/scripts/onchain-to-timeline.mjs` are the three places that must
agree on this vocabulary. Change one, change all three.

### Scripts pipeline

Per-recipe flows live in `scripts/src/recipes/{basic,timeout,chained,handoff}.ts`
and share snapshot scaffolding in `scripts/src/recipes/common.ts`. Each
flow broadcasts the recipe's txs, writes `run-NN.raw.json`, and
triggers `snapshotOnChain(...)` which writes `run-NN.onchain.json`
(full receipt DAGs + blocks + chunks, no state-series).

`audit.ts` reads both files per run, emits a per-recipe audit artifact,
and the aggregate + report commands roll those up.

When adding a new metric: derive it from the already-snapshotted
`onchain.json` shape rather than new RPC calls. Keeps old runs
reanalyzable offline.

### Network abstraction

All pipeline commands honour `NEAR_NETWORK=testnet|mainnet` (default
testnet). `scripts/src/config.ts` derives everything from that env var:
account names (`recipes.<master>`), RPC endpoints (FastNEAR testnet
vs. mainnet, both free tier), and expected chain_id. Mainnet and
testnet are equally supported teaching targets — testnet is the
default for casual hacking; mainnet is for reproducing the empirical
evidence under real validator load (see `docs/mainnet-readiness.md`).

Any subcommand that broadcasts a tx or destroys accounts must call
`assertChainIdMatches()` (scripts/src/rpc.ts) before signing — this
is enforced on `cmdDeploy`, `cmdRun`, and (as of the mainnet-readiness
work) `cmdClean`. Without the guard, a misconfigured RPC could act
on the wrong chain even when NEAR_NETWORK is set correctly.

### Viz

`viz/` is a Manim scene package. One scene + one synthetic timeline
per recipe, plus a Live variant that replays the scene against a
translator-generated timeline JSON from a real testnet snapshot:

- `viz/scenes/recipe_basic.py` → `RecipeBasic` / `RecipeBasicLive`
- `viz/scenes/recipe_timeout.py` → `RecipeTimeout` / `RecipeTimeoutLive`
- `viz/scenes/recipe_chained.py` → `RecipeChained` / `RecipeChainedLive`

Primitives (sphere, satellite, TimelinePlayer, palette, blooms) are
vendored from the sibling repo `/Users/mikepurvis/near/manim-visualizations`;
see `viz/common/ATTRIBUTION.md` for the re-sync path. Don't weaken the
sibling's layout invariants (safe frame, label overflow, satellite
hygiene) — a silent visual bug teaches the reader the wrong model.

## Voice principle — vocabulary tracks the contract

Before coining a paraphrase for prose, a teach card, or a docstring,
grep the contract source. Use the actual method name
(`recipe_basic_yield`, `recipe_chained_resume`, `on_counter_observed`),
NEP primitive (`Promise::new_yield`, `#[callback_result]`,
`200-block budget`), and trace event name (`recipe_resolved_ok`). Only
use coined terms when NEAR itself has no term for the concept.

## Scope discipline

Explicit non-goals, in order of how often they come up:

- **Saga templates / balance triggers / authorized executors.** The
  sibling `smart-account-contract` owns the saga-runner direction; a
  narrower copy here would dilute focus.
- **Multi-sig.** `near/core-contracts/multisig2` is canonical; we
  don't try to compete.
- **Additional recipes beyond the four.** Four is enough to teach
  the mechanic, the timeout, the composition pattern, and atomic value
  transfer. Growing the set would re-expand the repo into a sprawl.
- **Richer adapter / validator patterns.** Recipe 3 is a single shape;
  pluggable validators belong in the sibling.

### In scope (both networks)

**Mainnet + testnet: both supported.** The four invariants are
protocol-correctness claims that should hold on any NEAR network,
and the pipeline is network-agnostic. Testnet is the default for
casual hacking — free accounts, fast iteration — while mainnet is
the strongest empirical evidence (real validator load, real
cross-shard receipt forwarding under the demo's account layout).
See `docs/mainnet-readiness.md` for the mainnet bootstrap runbook,
cost estimate, and state-hygiene notes. `cmdClean` refuses to run
on either network without an explicit `--i-know-this-is-<network>`
flag; `cmdDeploy` soft-gates mainnet with a 3-second confirmation
window.
