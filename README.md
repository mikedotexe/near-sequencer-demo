# NEP-519 yield/resume — a visual recipe book

This repo is a compact, visual recipe book for NEAR's
[NEP-519 `yield`/`resume`](https://github.com/near/NEPs/blob/master/neps/nep-0519.md)
primitive.

## TL;DR — the 30-second take

- **What's here.** Four recipes on one `recipes` contract
  (basic / timeout / chained / handoff), each a minimal Rust
  method-pair + a runnable TypeScript flow + a Manim-animated
  scene driven by real on-chain snapshots. Verified on **both
  testnet and mainnet** — four invariants PASS identically on
  each, side-by-side in
  [`artifacts/comparative.md`](artifacts/comparative.md).
  Mainnet bootstrap runbook:
  [`docs/mainnet-readiness.md`](docs/mainnet-readiness.md).
- **What it proves.** Four machine-checked invariants on every run,
  visible as a PASS/FAIL header at the top of
  [`artifacts/testnet/report.md`](artifacts/testnet/report.md) and
  [`artifacts/mainnet/report.md`](artifacts/mainnet/report.md):
  **DAG-placement** (mechanic), **Budget** (NEP-519's 200-block
  timeout holds empirically), **Atomicity** (Recipe 4 actually moves
  value), **Shard-placement** (callbacks execute on the contract's
  home shard regardless of which shard the resume tx was signed
  from). Derivation of each in
  [`docs/invariants.md`](docs/invariants.md); three
  independent-verification paths (explorer / offline re-audit /
  archival re-fetch) in
  [`docs/verification.md`](docs/verification.md).
- **Mental model.** The yield tx is the root of a receipt tree;
  resume and timeout are both data-delivery ops against an already-
  scheduled callback receipt. That one sentence makes all four
  recipes cohere — §[Four invariants, machine-checked on every
  run](#four-invariants-machine-checked-on-every-run) below.
- **Why this matters.** NEAR's production intents contract
  (`intents.near`) processes all work synchronously in a single tx
  batch; that's one answer to multi-step coordination. Yield/resume
  is a different answer: **contract-controlled sequential receipt
  execution across block boundaries** — the contract pauses itself,
  waits for a signal that didn't exist at yield time, and resumes
  deterministically. See [`docs/intents-near.md`](docs/intents-near.md)
  for the architectural contrast grounded in live mainnet tx hashes.
- **Run it or read it.** `NEAR_NETWORK=testnet ./scripts/demo.sh all`
  reproduces the full pipeline on testnet;
  `NEAR_NETWORK=mainnet ./scripts/demo.sh all` reproduces on mainnet
  (~0.5–1 NEAR total; see the readiness runbook). Alternatively, read
  the committed `artifacts/testnet/report.md` to verify the claims
  without executing.
- **Animate it.** `cd viz && make all-recipes` renders four
  ~30-second synthetic scenes; the `*Live` variants replay against
  actual testnet snapshots.

Four self-contained recipes — each with its own minimal contract
method pair, runnable flow, and Manim-animated scene — answer four
concrete questions a NEAR dev hits when reaching for yield/resume
for the first time:

1. **Basic.** How do `Promise::new_yield` and `yield_id.resume` actually
   fit together across two transactions?
2. **Timeout.** What happens if no one ever resumes? Does the callback
   just sit there forever, or does the runtime do something?
3. **Chained.** How do I combine a yield/resume with a regular
   cross-contract call whose result I want to inspect in a callback?
4. **Atomic handoff.** Can the primitive actually *do something*, like
   move NEAR between two parties, with a safety valve if the recipient
   never shows up?

Each recipe is end-to-end: a Rust method pair on one shared `recipes`
contract, a TypeScript flow that broadcasts the txs and snapshots the
full receipt DAGs, an audit that parses the snapshotted trace events into
a lifecycle summary, and a Manim scene that animates the observable
moments against a timeline of real block heights.

The canonical target for recipe 3 is the classic NEAR
[counter](https://github.com/near/near-sdk-rs/tree/master/examples) —
one `i8` field, `increment / decrement / get_num`.

## Repo health

```sh
cargo build --release --target wasm32-unknown-unknown           # two wasms
cargo test --workspace                                          # unit tests
./scripts/node_modules/.bin/tsc --noEmit -p scripts/tsconfig.json
```

If these three commands pass, the repo is in a shippable state.

## The four recipes

All four method groups live in
[`contracts/recipes/src/lib.rs`](contracts/recipes/src/lib.rs). Recipes
1–3 share a `yields: BTreeMap<String, YieldId>` for cross-tx bookkeeping;
Recipe 4 has its own `handoffs` map because it carries access-control
metadata (the nominated recipient). Every observable moment emits a
structured trace log (`trace:{ev, recipe, name, ...}`) that the scripts
and viz pipelines parse.

### Recipe 1 — Basic cross-tx yield + resume

```rust
pub fn recipe_basic_yield(&mut self, name: String) -> Promise {
    let (promise, yield_id) = Promise::new_yield(
        "on_basic_resumed", callback_args, GAS_YIELD_CALLBACK, GasWeight(1),
    );
    self.yields.insert(format!("basic:{name}"), yield_id);
    promise
}

pub fn recipe_basic_resume(&mut self, name: String, payload: String) {
    let yield_id = self.yields.remove(&format!("basic:{name}")).unwrap();
    yield_id.resume(serde_json::to_vec(&BasicSignal { payload }).unwrap()).unwrap();
}

#[private]
pub fn on_basic_resumed(
    &mut self,
    name: String,
    #[callback_result] signal: Result<BasicSignal, PromiseError>,
) { ... }
```

Teaches the fundamental mechanic: tx1 yields, tx2 resumes, callback
fires with the resumed payload.

### Recipe 2 — Timeout: the callback fires anyway

```rust
pub fn recipe_timeout_yield(&mut self, name: String) -> Promise { ... }
// no recipe_timeout_resume

#[private]
pub fn on_timeout_resumed(
    &mut self,
    name: String,
    #[callback_result] signal: Result<BasicSignal, PromiseError>,
) {
    match signal {
        Err(_) => /* timeout path — emit recipe_resolved_err */,
        Ok(_)  => /* shouldn't happen without a resume method */,
    }
}
```

NEP-519 guarantees the callback fires **exactly once** per yield: via
an explicit resume carrying the payload, or after the fixed 200-block
budget with `PromiseError` in place of it. Empirically observed on
testnet: `timeout fired after 202 blocks (NEP-519 budget = 200)`.

### Recipe 3 — Chained: resume triggers a downstream call

```rust
pub fn recipe_chained_yield(&mut self, name: String, counter_id: AccountId) -> Promise { ... }
pub fn recipe_chained_resume(&mut self, name: String, delta: i8) { ... }

#[private]
pub fn on_chained_resumed(
    &mut self, name: String, counter_id: AccountId,
    #[callback_result] signal: Result<ChainedSignal, PromiseError>,
) -> PromiseOrValue<()> {
    let delta = signal?.delta;
    let call = if delta > 0 {
        ext_counter::ext(counter_id).with_static_gas(GAS_COUNTER_CALL).increment()
    } else {
        ext_counter::ext(counter_id).with_static_gas(GAS_COUNTER_CALL).decrement()
    };
    PromiseOrValue::Promise(call.then(
        ext_self::ext(env::current_account_id())
            .with_static_gas(GAS_OBSERVE_CALLBACK)
            .on_counter_observed(name),
    ))
}

#[private]
pub fn on_counter_observed(
    &mut self, name: String,
    #[callback_result] value: Result<i8, PromiseError>,
) { ... }
```

The canonical cross-contract composition, gated on a yielded resume.
The recipe's own receipt resolves only after `on_counter_observed`
reads the target's callback-visible return value.

### Recipe 4 — Atomic handoff: value moves on resume, refunds on timeout

```rust
#[payable]
pub fn recipe_handoff_yield(&mut self, name: String, to: AccountId) -> Promise {
    let amount = env::attached_deposit();
    // ... Promise::new_yield("on_handoff_resumed", {from, to, amount}) ...
    // contract holds `amount` until the callback fires.
}

pub fn recipe_handoff_resume(&mut self, name: String) {
    // permissionless: any signer can pull the trigger.
    // yield_id.resume(HandoffSignal {})  →  callback fires with Ok.
}

#[private]
pub fn on_handoff_resumed(
    &mut self, name: String, from: AccountId, to: AccountId, amount: NearToken,
    #[callback_result] signal: Result<HandoffSignal, PromiseError>,
) -> Promise {
    match signal {
        Ok(_)  => Promise::new(to).transfer(amount),    // Bob gets funds
        Err(_) => Promise::new(from).transfer(amount),  // Alice refunded
    }
}
```

Alice attaches NEAR to a yield naming Bob as the recipient. If anyone
resumes, the callback's Ok arm transfers to Bob. If nobody resumes,
the 200-block budget expires and the callback's Err arm refunds Alice.
**The single receipt scheduled at yield time carries both endings.**
No escrow table, no refund method, no polling — the primitive alone
moves value atomically, with the timeout as the built-in safety valve.
The destination is fixed at yield time, so the resumer can't redirect
the funds; if you wanted access-controlled resume (only Bob can pull
the trigger), that's a one-liner `require!(predecessor == stored.to)`
away, but the demo keeps resume permissionless to keep the focus on
the atomic value-transfer story.

Observable on testnet: `0.01 NEAR` per handoff. Claim path settles in
~10 blocks; timeout path settles in ~200 blocks (NEP-519 budget), and
the yield tx's DAG contains the full transfer receipt for whichever
ending fires.

## Four invariants, machine-checked on every run

These four invariants are the proof surface for the sequencing claim
from the TL;DR: *the contract paused itself, waited across block
boundaries, and resumed deterministically on NEAR mainnet.* Each
claim is derived from NEP-519 semantics (see
[`docs/invariants.md`](docs/invariants.md) for the full derivation);
each is machine-checked per run; each can be independently confirmed
by a reader without trusting this repo
([`docs/verification.md`](docs/verification.md)).

The mental model that makes all four recipes coherent:
**`Promise::new_yield` schedules the callback receipt at yield time.**
The receipt exists, lives in the yield tx's DAG, and waits for input.
`yield_id.resume(payload)` is a pure data-delivery op against that
already-scheduled receipt — it doesn't create a new one. The 200-block
timeout path is the same: when the budget expires, the runtime
delivers `PromiseError` to the receipt it already has.

The audit pipeline empirically checks four invariants on every
snapshotted run and rolls their PASS/VIOLATED status into
[`artifacts/testnet/report.md`](artifacts/testnet/report.md)'s
"Invariants at a glance" header. `scripts/demo.sh audit` exits
non-zero if any invariant is violated, so CI (and a human running the
pipeline by hand) learns immediately rather than from eyeballing JSON.

1. **DAG-placement.** Every trace event emitted by callback code —
   `recipe_resolved_ok`, `recipe_resolved_err`, `recipe_dispatched`,
   `recipe_callback_observed`, `handoff_released`, `handoff_refunded` —
   lives in the YIELD tx's `receipts_outcome[]`, even when execution
   is triggered by a later resume tx (basic, chained, handoff-claim)
   or a timeout (timeout, handoff-timeout). The resume tx's DAG
   contains only `recipe_resumed`. Written per run as a `dagPlacement`
   map + `dagInvariantViolations` list; current observed corpus:
   40/40 events in expected place across 10 runs.
2. **Budget.** The observed `yield→callback` block delta for timeout
   runs must lie in `[200, 205]` — NEP-519's stated 200-block budget
   plus small slack for chunk-inclusion latency. Checked for both
   Recipe 2 and Recipe 4's timeout mode. Current corpus: 2/2 inside
   the window, observed 202 in both cases.
3. **Atomicity (Recipe 4).** For each handoff run the snapshot must
   contain a `Transfer` receipt from the recipes contract to the
   expected recipient (Bob on claim, Alice on timeout) with `deposit`
   equal to the attached `amountYocto` and an outcome status of
   `SuccessValue`. Current corpus: 3/3 runs.
4. **Shard-placement.** Every callback-emitting receipt executes on
   the recipes contract's home shard, regardless of which shard the
   resume tx was signed from. Directly observable as
   `outcome.executor_id == recipes contract` — the protocol-level
   form of "the callback stays put on the contract's shard while
   cross-shard resume only forwards the payload." Current corpus:
   13/13 callback receipts on contract shard 4 across 10 runs. This
   invariant gains empirical weight on mainnet (fewer shards, more
   real cross-shard forwarding) — see
   [`docs/mainnet-readiness.md`](docs/mainnet-readiness.md).

The timeout recipe is the cleanest proof artifact.
`recipe-timeout/run-01` snapshots a single yield tx — there is no
second tx at 200 blocks — yet both `recipe_yielded` and
`recipe_resolved_err` are present in its DAG, at block heights 202
apart. The runtime extended an existing receipt's outcome; it did not
materialize a fresh one.

## Running the book end-to-end

```sh
scripts/demo.sh build
scripts/demo.sh deploy
scripts/demo.sh run basic   --repeat 3
scripts/demo.sh run chained --repeat 3
scripts/demo.sh run timeout --repeat 1                   # ~4 min wait
scripts/demo.sh run handoff --mode claim   --repeat 2
scripts/demo.sh run handoff --mode timeout --repeat 1    # ~4 min wait
scripts/demo.sh audit basic && scripts/demo.sh audit timeout \
    && scripts/demo.sh audit chained && scripts/demo.sh audit handoff
scripts/demo.sh aggregate && scripts/demo.sh report
```

Artifacts land under `artifacts/testnet/recipe-{basic,timeout,chained}/`:
each run produces a `run-NN.raw.json` (tx hashes + timing), a
`run-NN.onchain.json` (full receipt DAGs + blocks + chunks), and after
audit a `run-NN.audit.json` (parsed lifecycle summary). The final
`report.md` has a table per recipe linking to every tx on
[nearblocks.io](https://testnet.nearblocks.io).

To inspect the DAG-placement of trace events for a single snapshotted run
(the reproducibility hook for the "yield tx is the root of the receipt
tree" framing above):

```sh
scripts/demo.sh explain-dag basic 1      # → table: event | found in | expected | block
scripts/demo.sh explain-dag timeout      # defaults to first snapshotted run
scripts/demo.sh explain-dag chained 2
```

## Accounts (both networks)

Account names template on the master via `NEAR_NETWORK`:

```
mike.testnet  (NEAR_NETWORK=testnet)         mike.near  (NEAR_NETWORK=mainnet)
├── recipes.mike.testnet                     ├── recipes.mike.near
├── recipes-counter.mike.testnet             ├── recipes-counter.mike.near
└── bob.mike.testnet                         └── bob.mike.near
```

`bob` is a non-contract account created at deploy time so Recipe 4 can
actually deliver funds to a distinct principal — the handoff's `to`
parameter gets a real on-chain destination with a balance you can
watch change. The demo's resume is permissionless (Alice signs it);
swapping in a `require!(predecessor == stored.to, ...)` on the resume
method would gate it to Bob if you want that guarantee.

**On both networks**, `scripts/demo.sh clean` refuses to destroy
accounts without an explicit `--i-know-this-is-<network>` ack and a
chain-id guard check (so a misconfigured RPC can't delete accounts on
the wrong chain). Mainnet deploy soft-gates with a 3-second confirmation
window after printing the target account list. See
[`docs/mainnet-readiness.md`](docs/mainnet-readiness.md) for the full
mainnet bootstrap runbook (credentials, funding, expected cost, state
hygiene).

## Trace events

Every observable moment in the recipes contract emits a JSON log line
prefixed `trace:`. Scripts filter by prefix, then `JSON.parse` the body.

| event | recipe | carries |
|---|---|---|
| `recipe_yielded` | any | `name` |
| `recipe_resumed` | basic, chained, handoff-claim | `name`, `payload` |
| `recipe_dispatched` | chained | `name`, `target`, `method` |
| `recipe_callback_observed` | chained | `name`, `value` |
| `recipe_resolved_ok` | basic, chained, handoff-claim | `name`, `outcome` |
| `recipe_resolved_err` | timeout, handoff-timeout | `name`, `reason` |
| `handoff_offered` | handoff (yield time) | `name`, `from`, `to`, `amount` |
| `handoff_released` | handoff (claim settle) | `name`, `to`, `amount` |
| `handoff_refunded` | handoff (timeout settle) | `name`, `refunded_to`, `amount` |

If you add a new event variant, update three places in lockstep:
the `TraceEvent` enum in `contracts/recipes/src/lib.rs`, the trace
parser in `scripts/src/audit.ts`, and the translator in
`viz/scripts/onchain-to-timeline.mjs`.

## Animation

`viz/` is a Manim scene package driven by hand-authored synthetic
timelines + translator-generated live timelines from `onchain.json`
snapshots. One scene per recipe plus a Live variant for each:

```sh
cd viz/
make recipe-basic recipe-timeout recipe-chained     # -ql synthetic
make recipe-basic-hq                                 # -qh for sharing
./scripts/onchain-to-timeline.mjs --raw ../artifacts/testnet/recipe-basic/run-01.raw.json \
    --out data/recipe-basic-live-01.json
manim -ql scenes/recipe_basic.py RecipeBasicLive
```

Viz primitives (sphere, satellite, timeline player, blooms, palette)
are **vendored** from the sibling repo
`/Users/mikepurvis/near/manim-visualizations`; see
[`viz/common/ATTRIBUTION.md`](viz/common/ATTRIBUTION.md) for the source
and re-sync path.

## References

- **NEP-519 yield/resume** — https://github.com/near/NEPs/blob/master/neps/nep-0519.md
- **NEAR nomicon — receipt model** — https://nomicon.io/RuntimeSpec/Receipts
- **near-sdk-rs yield/resume API** — https://docs.rs/near-sdk/latest/near_sdk/
- **Sibling saga-runner** — `/Users/mikepurvis/near/smart-account-contract`
  is a full-featured smart account built on the same yield/resume
  primitive: durable saga templates, balance triggers, authorized
  executors, three resolution policies (direct / adapter / asserted).
  If you want the production shape rather than a pedagogical one, that
  repo is where to look.

## Not included (and why)

- **Automation / triggers / saga templates.** Sibling owns that direction.
- **Multi-sig.** `near/core-contracts/multisig2` is canonical.
- **More than four recipes, *for now*.** Four is enough to teach the
  core mechanic, the timeout, composition with cross-contract calls,
  and atomic value transfer with safety valve — that's Volume 1. A
  single Recipe 5 (solver-auction NEAR Intent) is sketched in
  [`docs/volume-2-intents.md`](docs/volume-2-intents.md): contract
  method signatures, trace events, expected DAG placements, plus the
  two new invariants (exactly-one-winner, cascade-fail ordering) a
  solver-contention shape needs. The viz layer already carries the
  matching handlers (see [`viz/DESIGN.md`](viz/DESIGN.md) §"Volume 2"
  and [`viz/common/ATTRIBUTION.md`](viz/common/ATTRIBUTION.md)), so a
  Volume 2 ship is an additive change, not a refactor. The sketch
  has a stated deadline — **2026-10-19** — past which the scaffolding
  gets deleted if the sibling adapter or an external motivation
  hasn't landed to trigger the work.

## Voice principle — vocabulary tracks the contract

Before coining a paraphrase for prose or a teach card, grep the contract
source. Use the actual method name (`recipe_basic_yield`,
`recipe_chained_resume`, `on_counter_observed`), NEP primitive
(`Promise::new_yield`, `#[callback_result]`, `200-block budget`), and
trace event name (`recipe_resolved_ok`). Only coin new vocabulary when
NEAR itself has no term for the concept.
