# Volume 2 — NEAR Intents primer (deferred)

Volume 1 (this repo's four recipes) teaches the NEP-519 yield/resume
mechanic in isolation: basic, timeout, chained, handoff. A plausible
Volume 2 would extend the pattern to solver contention — a NEAR
Intents-style auction where multiple solvers race inside one yielded
callback's 200-block budget.

**Status: deferred.** The repo's "four is enough" claim is load-bearing
for the pedagogy; adding a fifth recipe speculatively would dilute
that. If Volume 2 ever ships, it ships in response to a concrete
trigger — not ahead of one.

## Trigger and fallback

**Ship when either of these fires first:**

1. **The sibling
   [`smart-account-contract`](../../smart-account-contract) lands its
   intent-adapter pattern in production.** That shape would give
   Volume 2 a pedagogical mirror to crib method signatures and trace
   events from, rather than inventing them here.
2. **An external motivation lands** — a grant, a demo ask, an
   upstream NEP that needs a concrete demonstration.

**Fallback: 2026-10-19.** If neither trigger has fired by that date,
delete this document and close the chapter. A `volume-2-intents.md`
that sits undeleted for years becomes noise, not aspiration.

## What Volume 2 would add

Two invariants the four-invariant set in
[`invariants.md`](invariants.md) doesn't currently exercise, both
contention-specific:

- **Exactly-one-winner.** Per intent run, exactly one `solver_won`
  event fires; no intent adopts two solvers.
- **Cascade-fail ordering.** Every losing solver receives a
  `solver_lost` event in the same commit tx, *before* any downstream
  `intent_executing`. Prevents a losing solver from observing target
  state before the winner has been atomically selected.

Both slot into the existing `computeXInvariant` + aggregate + report
+ CI infrastructure without refactor; the aggregate layer already
supports *n* invariants.

## Cross-repo pointer

The sibling [`smart-account-contract`](../../smart-account-contract)
already models solver selection + adapter verification in production.
When its intent-adapter pattern stabilizes, it's the natural starting
point for Volume 2 here — the recipe book teaches what the sibling
runs, not a parallel invention.

Until then, stay focused on making Volume 1 even more rigorous and
reconfirmable. "Four is enough" is the working claim; Volume 2 is
the option value.
