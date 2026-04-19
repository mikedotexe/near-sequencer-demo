# Volume 2 — NEAR Intents primer (planned)

Volume 1 (this repo's four recipes) teaches the NEP-519 yield/resume
mechanic in isolation: basic, timeout, chained, handoff. Volume 2
points at a composition pattern the primitive is actually used for in
production — a NEAR Intents solver auction — and the invariants a
working implementation has to satisfy.

Status: **this is a sketch, not a shipped recipe.** The viz layer
already carries scaffolding for the event vocabulary below (see
[`../viz/DESIGN.md`](../viz/DESIGN.md) §"Volume 2" and
[`../viz/common/ATTRIBUTION.md`](../viz/common/ATTRIBUTION.md)); the
contract side is what this document exists to scope.

## When this ships — concrete trigger and fallback

To keep Volume 2 from drifting into open-ended suspense, both the
trigger and the fallback are stated explicitly:

**Ship when either of these fires first:**

1. **The sibling [`smart-account-contract`](../../smart-account-contract)
   lands its intent-adapter pattern.** Its saga-runner already models
   solver selection + adapter verification in production; when that
   shape stabilizes, Recipe 5 becomes the pedagogical mirror — method
   signatures and trace events cribbed from the sibling so the
   recipe book teaches what the sibling runs. This is the preferred
   trigger: the production shape validates the pedagogical one.

2. **A separate external motivation lands** (grant, demo ask,
   teaching engagement, peer request). In that case the sketch below
   is the starting point and the sibling can be mined for trace-
   event conventions without waiting on its shape to stabilize.

**Fallback — delete the scaffolding by 2026-10-19** (6 months after
the initial sketch on 2026-04-19) if neither trigger has fired.
Concrete removal list:

- `docs/volume-2-intents.md` (this file)
- The eight dormant handlers in `viz/common/timeline.py`:
  `visit_start`, `visit_complete`, `cascade_fail`, `inner_dispatch`,
  `inner_return`, `decay`, `camera_focus`, `camera_restore`. See
  [`../viz/common/ATTRIBUTION.md`](../viz/common/ATTRIBUTION.md)
  "Retained as Volume 2 scaffolding" — each handler is one contiguous
  block; removal is one sed per handler.
- The "Volume 2 — Intents primer (planned)" section in
  [`../viz/DESIGN.md`](../viz/DESIGN.md).
- The Volume 2 bullet in [`../README.md`](../README.md)'s
  "Not included (and why)" section.

Net cleanup: ~400 lines. Carrying the scaffolding for 6 months at
~260 lines of dormant code + ~150 lines of speculative docs is
cheap; carrying it past that would be costume.

**How to check at the deadline.** `git log --since=2026-04-19 --
docs/volume-2-intents.md viz/common/timeline.py viz/DESIGN.md`. If
the log shows no edits beyond the initial authoring, pull the plug.

## Why Volume 2

A solver auction exercises everything Volume 1 teaches, simultaneously,
under a real contention pattern:

- **Basic** yield/resume — the intent posts a yield and waits for a
  winner.
- **Timeout** — if no solver commits inside the 200-block budget, the
  intent's Err arm refunds whoever funded it.
- **Chained** cross-contract composition — the winning solver's
  execution goes out as a normal `FunctionCall` with a `.then()`
  callback that verifies the result before the intent's yielded
  receipt resolves.
- **Handoff**-style atomic value transfer — the winning bid's
  settlement delivers funds to the intent's payer, gated on the
  verification callback succeeding.

The distinguishing novelty vs Volume 1 is **contention**. Volume 1
has one caller on each side (yield signer, resume signer). Volume 2
has N solvers racing inside a single yielded receipt's budget, and
only one can win. The interesting invariants are the ones that govern
that race.

## Recipe 5 sketch: `intent_auction`

### Shape

One intent owner (Alice) posts a yielded intent describing work she
wants done. Some number of solvers (solver_a, solver_b, solver_c)
enter a bidding window inside the 200-block budget. The first solver
whose `commit` call is accepted by the intent contract wins; all
other solvers receive a `PromiseError`-equivalent notification
(`cascade_fail`) and release cleanly. The winner's execution is
verified by a callback inside the yielded receipt before the intent's
Ok arm runs.

```
block N:       Alice signs recipe_intent_open(name, spec) — yield
               emits: intent_opened
block N+1..3:  solver_{a,b,c} each call recipe_intent_bid(name)
               emits: solver_entered{solver_id} (one per bid)
block N+5:     solver_a calls recipe_intent_commit(name, execution)
               emits: solver_won{solver_id=a}
                      solver_lost{solver_id=b}   ← cascade_fail, synthetic
                      solver_lost{solver_id=c}   ← cascade_fail, synthetic
block N+6:     resume delivers commit payload to yielded callback;
               callback dispatches execution as a cross-contract call
               emits: intent_executing{target, method}
block N+8:     .then(on_intent_verified) observes result
               emits: intent_verified{result}
block N+8:     callback's Ok arm fires:
               - Promise::new(intent_payer).transfer(amount)  (if value intent)
               - emits: recipe_resolved_ok
               OR, if budget expires first:
               emits: recipe_resolved_err
                      intent_refunded{to=intent_payer, amount}
```

### Contract API

The recipes crate gets a fifth method group:

```rust
#[payable]
pub fn recipe_intent_open(&mut self, name: String, spec: IntentSpec) -> Promise;
// Stores an IntentMeta in a new `intents: BTreeMap<String, IntentMeta>`.
// Attached deposit (if any) is the value carried for the intent.
// Yields with callback = on_intent_resumed, prepays 150 Tgas for the
// callback (enough to cover downstream dispatch + verification).

pub fn recipe_intent_bid(&mut self, name: String) -> Promise;
// Permissionless. Appends predecessor to IntentMeta.solvers.
// Emits solver_entered. Does NOT resume the yield.

pub fn recipe_intent_commit(&mut self, name: String, execution: ExecutionArgs);
// Permissionless, but only the first caller with a valid bid wins —
// checks predecessor ∈ IntentMeta.solvers AND IntentMeta.winner == None.
// Atomically: sets winner = predecessor, emits solver_won{predecessor}
// + solver_lost{x} for each other solver, then yield_id.resume() with
// the execution args.

#[private]
pub fn on_intent_resumed(
    &mut self, name: String,
    #[callback_result] signal: Result<CommitSignal, PromiseError>,
) -> PromiseOrValue<()>;
// Ok arm: dispatch execution as a FunctionCall, chain
//   .then(on_intent_verified). Returns the outer promise.
// Err arm: timeout — emit intent_refunded, transfer amount back to
//   the intent payer, return PromiseOrValue::Value(()).

#[private]
pub fn on_intent_verified(
    &mut self, name: String,
    #[callback_result] result: Result<VerifyResult, PromiseError>,
);
// Distinct from on_intent_resumed. This callback fires inside the
// yielded receipt (not after another yield) because the downstream
// FunctionCall was chained via .then() on the yield's resume Promise.
```

### Storage

```rust
pub struct IntentMeta {
    pub yield_id: YieldId,
    pub payer: AccountId,
    pub deposit: NearToken,
    pub spec: IntentSpec,
    pub solvers: Vec<AccountId>,
    pub winner: Option<AccountId>,
}

// Per-contract field in Recipes:
// intents: BTreeMap<String, IntentMeta>,
```

Separate from `handoffs` because the access-control + solver-set
metadata is much richer than the handoff's `(yield_id, to)` pair.

### Trace events

Add to `TraceEvent` in `contracts/recipes/src/lib.rs`:

| event | carries | emitted from |
|---|---|---|
| `intent_opened` | `name, payer, amount, spec_hash` | `recipe_intent_open` |
| `solver_entered` | `name, solver_id` | `recipe_intent_bid` |
| `solver_won` | `name, solver_id` | `recipe_intent_commit` |
| `solver_lost` | `name, solver_id, reason=cascade_fail` | `recipe_intent_commit` |
| `intent_executing` | `name, target, method, gas` | `on_intent_resumed` Ok arm |
| `intent_verified` | `name, result` | `on_intent_verified` Ok arm |
| `intent_refunded` | `name, refunded_to, amount` | `on_intent_resumed` Err arm |

Keep `recipe_yielded` / `recipe_resolved_{ok,err}` alongside these so
the DAG-placement audit vocabulary stays unchanged.

Same three-site update rule as Volume 1: the enum in
`contracts/recipes/src/lib.rs`, the parser in
`scripts/src/audit.ts`, and the translator in
`viz/scripts/onchain-to-timeline.mjs` must all grow together. An
orphan event in any one site silently breaks either the audit or the
viz.

### Expected DAG placements

| event | expected tx DAG |
|---|---|
| `intent_opened` | yield |
| `solver_entered` | bid tx's own DAG (one per solver; each is a normal FunctionCall) |
| `solver_won` | commit tx's DAG (resume tx, analogous to basic's resume) |
| `solver_lost` | commit tx's DAG |
| `recipe_resumed` | commit tx's DAG |
| `intent_executing` | yield tx's DAG (fires on the already-scheduled callback) |
| `intent_verified` | yield tx's DAG (chained callback) |
| `recipe_resolved_ok` / `recipe_resolved_err` | yield tx's DAG |
| `intent_refunded` | yield tx's DAG (timeout refund) |

The existing `computeDagPlacement` table in `scripts/src/audit.ts`
extends by one recipe entry; no new mechanism needed.

## New invariants Volume 2 requires

Volume 1's three invariants (DAG-placement, budget, atomicity) all
still hold for Recipe 5, with atomicity expanding to cover the
intent's value transfer. But the solver-contention shape introduces
two new invariants that didn't need to exist before:

### 4. Exactly-one-winner

Per intent run, the count of `solver_won` events must equal 1 exactly.
Zero winners (timeout path, no commit) is an Err resolution, not a
violation — in that case the count is 0 AND `recipe_resolved_err` +
`intent_refunded` are present.

Why machine-check: a successful commit that fails to atomically reject
sibling bids would be a consensus-breaking race where two solvers
believe they both won. The primitive prevents this structurally
(winner-set mutation happens before the resume call, which is itself
atomic with the rest of the callback), but the invariant is the place
the reader verifies it holds.

### 5. Cascade-fail ordering

For each intent run with a winner, every losing solver in
`IntentMeta.solvers` (excluding the winner) must receive a
corresponding `solver_lost` event in the same commit tx, and all
`solver_lost` events must be emitted *before* the downstream
`intent_executing`. Ordering is preserved because all events live on
the commit tx's DAG in the order the contract emits them — but the
audit should assert it rather than assume.

Why machine-check: if execution could start before cascade_fail
completes, a losing solver could observe the intent's target state
and mistakenly believe they won. Contract-level invariant (the
`recipe_intent_commit` method emits cascade_fail synchronously before
returning), audit-level verification.

## Visual story

The viz primitives needed are already in
[`../viz/common/timeline.py`](../viz/common/timeline.py), retained
from the original sibling vendor specifically for this recipe:

- `visit_start` / `visit_complete` — solver dwell windows inside
  the 200-block budget; satellite wedge ticks while the solver
  deliberates.
- `cascade_fail` — single event emitting synchronous red shockwaves
  on losing sibling satellites the moment the winner's `settle_ok`
  fires.
- `inner_dispatch` / `inner_return` — the winner's execution
  courier, distinct from `downstream_call` because it composes inside
  a yielded receipt rather than triggering one.
- `decay` — timeout as physical disintegration, distinct from
  `settle(status=timeout)`; enables near-miss storytelling at the
  199/200-block boundary.

See [`../viz/common/ATTRIBUTION.md`](../viz/common/ATTRIBUTION.md)
for the one-line deletes if Volume 2 gets descoped.

## Deferred, not rejected

Two explicit non-choices this sketch carries:

- **No solver staking.** A real intents protocol might require solvers
  to post collateral in `recipe_intent_bid` so misbehavior is
  punishable. That belongs in the sibling
  [`smart-account-contract`](../../smart-account-contract), whose
  saga-runner + balance-trigger scaffolding already models staking.
  Volume 2's Recipe 5 stays pedagogical.
- **No partial fills.** Each intent is atomic: one winner, one
  execution, one settlement. Partial fills, order-book composition,
  and multi-asset settlement are out of scope.

If Volume 2 ships, it ships one recipe. If demand for a sixth emerges
later, Volume 3 can model it; the pattern scales by recipe count, not
by cramming more into one.

## Sizing

Guess at the delta (vs shipping Volume 1):

- Contract: ~350 lines (one method group, one storage map, ~7 trace
  event variants).
- Scripts: ~250 lines (a `scripts/src/recipes/intent.ts`, parser
  extension in `audit.ts`, new `computeExactlyOneWinner` +
  `computeCascadeOrdering` invariants).
- Viz: one new scene file (~150 lines); no `common/` changes since
  the handlers are already vendored.
- Docs: update `README.md`'s "four recipes" → "five recipes"; expand
  the invariants section to six; add a `Recipe 5` block with the
  method-pair cameo.

Ballpark: 2-4 days of focused work for a shipped volume. The
scaffolding (viz primitives, report rendering, invariant
infrastructure) is already in place.
