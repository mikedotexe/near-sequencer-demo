# NEP-519 yield/resume — a visual recipe book

This repo is a compact, visual recipe book for NEAR's
[NEP-519 `yield`/`resume`](https://github.com/near/NEPs/blob/master/neps/nep-0519.md)
primitive. Four self-contained recipes — each with its own minimal
contract method pair, runnable flow, and Manim-animated scene — answer
four concrete questions a NEAR dev hits when reaching for yield/resume
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
contract, a TypeScript flow that broadcasts the txs and captures the
full receipt DAGs, an audit that parses the captured trace events into
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

## The yield tx is the root of a receipt tree

The mental model that makes all four recipes coherent:
**`Promise::new_yield` schedules the callback receipt at yield time.**
The receipt exists, lives in the yield tx's DAG, and waits for input.
`yield_id.resume(payload)` is a pure data-delivery op against that
already-scheduled receipt — it doesn't create a new one. The 200-block
timeout path is the same: when the budget expires, the runtime
delivers `PromiseError` to the receipt it already has.

Consequence (machine-checked by `scripts/demo.sh audit`):
**every trace event emitted by callback code — `recipe_resolved_ok`,
`recipe_resolved_err`, `recipe_dispatched`, `recipe_callback_observed` —
lives in the YIELD tx's `receipts_outcome[]`**, even when execution
is triggered by a later resume tx (basic, chained) or a timeout
(timeout). The resume tx's DAG contains only `recipe_resumed`. The
audit writes this into each `run-NN.audit.json` as a `dagPlacement`
map and loud-fails if it ever drifts.

The timeout recipe is the proof artifact. `recipe-timeout/run-01`
captures a single yield tx — there is no second tx at 200 blocks —
yet both `recipe_yielded` and `recipe_resolved_err` are present in
its DAG, at block heights 202 apart. The runtime extended an existing
receipt's outcome; it did not materialize a fresh one.

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

To inspect the DAG-placement of trace events for a single captured run
(the reproducibility hook for the "yield tx is the root of the receipt
tree" framing above):

```sh
scripts/demo.sh explain-dag basic 1      # → table: event | found in | expected | block
scripts/demo.sh explain-dag timeout      # defaults to first captured run
scripts/demo.sh explain-dag chained 2
```

## Accounts (testnet-only)

```
mike.testnet
├── recipes.mike.testnet              ← the recipe book contract
├── recipes-counter.mike.testnet      ← counter (target for Recipe 3)
└── bob.mike.testnet                  ← nominated handoff recipient (Recipe 4)
```

`bob` is a non-contract account created at deploy time so Recipe 4 can
actually deliver funds to a distinct principal — the handoff's `to`
parameter gets a real on-chain destination with a balance you can
watch change. The demo's resume is permissionless (Alice signs it);
swapping in a `require!(predecessor == stored.to, ...)` on the resume
method would gate it to Bob if you want that guarantee.

The repo is testnet-only by design: a static teaching artifact doesn't
belong in archival. `scripts/demo.sh` refuses mainnet deploy without an
explicit `--i-know-this-is-mainnet` ack, and we don't encourage it.

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
captures. One scene per recipe plus a Live variant for each:

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

- **Mainnet deploy.** This is a static teaching artifact. Mainnet
  archival permanence is wasted here.
- **Automation / triggers / saga templates.** Sibling owns that direction.
- **Multi-sig.** `near/core-contracts/multisig2` is canonical.
- **More than four recipes.** Four is enough to teach the mechanic, the
  timeout, composition with cross-contract calls, and atomic value
  transfer with safety valve. Adding more risks diluting the focus.

## Voice principle — vocabulary tracks the contract

Before coining a paraphrase for prose or a teach card, grep the contract
source. Use the actual method name (`recipe_basic_yield`,
`recipe_chained_resume`, `on_counter_observed`), NEP primitive
(`Promise::new_yield`, `#[callback_result]`, `200-block budget`), and
trace event name (`recipe_resolved_ok`). Only coin new vocabulary when
NEAR itself has no term for the concept.
