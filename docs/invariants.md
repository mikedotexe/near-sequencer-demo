# Four invariants of NEP-519 yield/resume

The recipes in this repo make four specific claims about how NEAR's
[NEP-519 yield/resume](https://github.com/near/NEPs/blob/master/neps/nep-0519.md)
primitive behaves. Each claim is machine-checked on every snapshotted
run and surfaces on the top of
[`../artifacts/testnet/report.md`](../artifacts/testnet/report.md).
This document explains *why* each invariant exists — derivation from
NEP-519 semantics, what a violation would mean, and where it's
enforced in code.

The empirical status (how many runs currently PASS) lives in
`report.md`'s "Invariants at a glance" header. This document stays
the same as runs accumulate; only the report's counts move.

## At a glance

| # | Invariant | Claim | Applies to | Where checked |
|---|-----------|-------|------------|---------------|
| 1 | DAG-placement | Callback trace events live in the yield tx's receipt DAG | all four recipes | [`scripts/src/audit.ts`](../scripts/src/audit.ts) `computeDagPlacement` |
| 2 | Budget | Observed yield→callback delta lies in [200, 205] blocks | timeout + handoff-timeout | [`scripts/src/audit.ts`](../scripts/src/audit.ts) `checkBudget` |
| 3 | Atomicity | Transfer receipt matches recipient + amount + SuccessValue | handoff | [`scripts/src/audit.ts`](../scripts/src/audit.ts) `checkAtomicity` |
| 4 | Shard-placement | Callback-emitting receipts execute on the contract's home shard | all four recipes | [`scripts/src/audit.ts`](../scripts/src/audit.ts) `computeShardPlacement` |

## 1. DAG-placement

**Claim.** Every trace event emitted by callback code —
`recipe_resolved_ok`, `recipe_resolved_err`, `recipe_dispatched`,
`recipe_callback_observed`, `handoff_released`, `handoff_refunded` —
lives in the YIELD tx's `receipts_outcome[]`, regardless of which tx
triggered its execution. The resume tx's DAG contains only
`recipe_resumed` (emitted by the resume method itself, which is an
ordinary FunctionCall).

**Derivation.** NEP-519 specifies two API entry points:

- `Promise::new_yield(method, args, gas, weight) -> (Promise, YieldId)`
  — schedules a new *yielded receipt* that is immediately in the
  receipt DAG of the current transaction, with status "awaiting input."
- `yield_id.resume(payload)` — delivers `payload` to the
  already-scheduled yielded receipt, causing it to become executable.
  This does **not** create a new receipt.

If `resume` does not fire, the runtime delivers `PromiseError` to the
same already-scheduled receipt after 200 blocks. Either way, the
receipt where the callback executes was created — and its position in
the receipt DAG was fixed — at yield time.

So any `receipt_outcome` emitted by the callback's execution appears
in the yield tx's `receipts_outcome[]`, because that's where the
receipt is anchored in the causal tree.

**Consequence of violation.** If any callback-emitted trace event
landed in the resume tx's DAG, it would mean the runtime created a
new receipt at resume time — contradicting NEP-519. Either the spec
drifted (a near-sdk bump changed receipt creation semantics) or the
audit's DAG-walking logic is wrong. Either way, the reader should be
told loudly and the claim-to-evidence chain should visibly break
before a reader trusts a misleading report.

**Where it's checked.**
[`scripts/src/audit.ts:computeDagPlacement`](../scripts/src/audit.ts)
walks every snapshotted tx's `receipts_outcome[]` and matches each
expected trace event (per a recipe-specific table) to its actual tx
role. Mismatches are recorded as `dagInvariantViolations[]` in each
`run-NN.audit.json`, rolled up per recipe by `computeDagInvariant` in
`aggregate.ts`, and rendered as PASS/VIOLATED in `report.md`. The
audit subcommand exits non-zero on any violation.

**Why this matters.** Without this invariant holding, the mental model
that makes all four recipes cohere — *"the yield tx is the root of a
receipt tree; resume and timeout are data-delivery ops against an
already-scheduled callback receipt"* — is empirically false. Every
other invariant and every animation in `viz/` depend on this mental
model being accurate.

## 2. Budget

**Claim.** The observed yield→callback block delta for timeout paths
lies in the range `[200, 205]`.

**Derivation.** NEP-519 specifies a fixed 200-block budget for yielded
receipts. The sequence is:

1. Block Y: yield tx is included; yielded receipt enters the DAG with
   a 200-block deadline.
2. Block Y+200: deadline elapses. Runtime schedules `PromiseError`
   delivery on the yielded receipt.
3. Block Y+200+k (k typically 1–2): the runtime includes the callback
   receipt's execution in the next chunk-production slot on its shard.

So the observed delta is ≥ 200 (exactly the budget, never less) and
up to ~205 (with k blocks of chunk-inclusion latency as slack).

**Bounds.** `[200, 205]` chosen as follows:

- Lower = 200 (exact spec). Firing earlier would indicate the budget
  shrank — a protocol-level change we should surface immediately.
- Upper = 205. Chunk-production jitter on testnet is typically 0–3
  blocks; 5 gives comfortable slack without being so wide that real
  drift gets masked. Observed corpus sits at 202 consistently.

If the observed corpus widens, these bounds get widened in
[`scripts/src/audit.ts`](../scripts/src/audit.ts) as
`BUDGET_LOWER_BLOCKS` / `BUDGET_UPPER_BLOCKS`.

**Consequence of violation.** A delta outside `[200, 205]` means one
of three things:

- The protocol's yield budget changed (e.g., a near-sdk bump altered
  the constant). A real spec drift that should surface.
- The snapshot didn't capture the callback receipt (the audit
  couldn't locate it, so `blocksFromYieldToCallback` came back null
  or stale). A data-quality bug.
- The audit's block-height resolution is wrong. A logic bug.

All three are "stop and look" events.

**Where it's checked.**
[`scripts/src/audit.ts:checkBudget`](../scripts/src/audit.ts). Applied
to Recipe 2's `blocksFromYieldToCallback` and Recipe 4 timeout mode's
`blocksFromYieldToSettle`. Per-run result stored as `budgetInvariant`
on each audit; aggregated by `computeBudgetInvariant` in
`aggregate.ts`.

**Why this matters.** The 200-block budget is *the* reason
`Promise::new_yield` is safe to use for cross-tx coordination: it
bounds worst-case latency so contracts holding value in yielded
callbacks can't have funds stuck indefinitely. Turning the spec text
into a measured empirical fact on every run means the contract
writer doesn't have to trust a document — the audit proves it, and
protocol drift shows up on the next run.

## 3. Atomicity (Recipe 4)

**Claim.** For each handoff run, the snapshotted tx DAG contains an
Action Receipt with a Transfer action that satisfies four conditions:

- `predecessor_id = recipes` (the contract itself)
- `receiver_id = expectedRecipient`
  (Bob on claim mode, the yield signer on timeout mode)
- `deposit = amountYocto` (the exact amount attached at yield time)
- outcome status = `SuccessValue`

**Derivation.** Recipe 4's callback `on_handoff_resumed` has two arms:

- On `Ok(_)`: `Promise::new(to).transfer(amount)` — the callback
  dispatches an Action Receipt with a Transfer action targeting the
  nominated recipient with the amount held by the contract since
  yield time. This is the claim path.
- On `Err(_)`: `Promise::new(from).transfer(amount)` — same shape,
  but targeting the original signer. This is the refund path.

Both paths are contract code running inside the yielded callback
receipt's execution. The Transfer receipts they dispatch live in the
yield tx's DAG (consequence of the DAG-placement invariant —
Transfer receipts dispatched by a receipt inherit its DAG position).

For the handoff to "actually move value atomically," that Transfer
receipt must exist and succeed. The four conditions collectively
verify this empirically rather than trusting the contract source.

**Consequence of violation — what each field breaking would mean.**

- **Missing receipt.** Funds didn't move. The callback either didn't
  execute or didn't dispatch the Transfer. Recipe 4's central claim
  is empirically false for that run.
- **Wrong recipient.** Callback logic routed funds incorrectly, or
  callback args were tampered with in transit. Breaks the nominated-
  recipient invariant (`to` fixed at yield time).
- **Wrong deposit.** Something in the yield-to-callback arg-passing
  is lossy. Would break the "exactly amount" claim.
- **Failed outcome status.** The Transfer action itself reverted
  (recipient account doesn't exist, protocol-level rejection, …).
  Funds returned to the contract but didn't reach the intended
  destination. In practice a recoverable situation — but not an
  atomic one.

The atomic-handoff claim is the central contract-level deliverable of
Recipe 4. A violation forces revisiting the whole recipe.

**Where it's checked.**
[`scripts/src/audit.ts:checkAtomicity`](../scripts/src/audit.ts).
Walks `tx.receipts` across both yield and resume DAGs for Action
Receipts whose predecessor is the recipes contract and whose receiver
matches the expected recipient; filters to the first Transfer action;
compares against `(expectedRecipient, expectedAmountYocto,
succeeded=true)`. Per-run result stored as `atomicityInvariant`;
aggregated by `computeAtomicityInvariant` in `aggregate.ts`.

**Why this matters.** The "primitive moves value atomically" claim is
the most economically meaningful thing the recipe book says. If we
don't prove it empirically, we're asking the reader to trust the
contract source. Recipe 4's value proposition — *one receipt carries
both endings, no escrow table, no polling* — becomes citable only
when every snapshotted run has receipts showing the claimed flow.

## 4. Shard-placement

**Claim.** Every callback-emitting trace event — the same set covered
by DAG-placement: `recipe_resolved_ok`, `recipe_resolved_err`,
`recipe_dispatched`, `recipe_callback_observed`, `handoff_released`,
`handoff_refunded` — executes on the shard that owns the recipes
contract (the contract's **home shard**). Neither the resume-tx
signer's shard nor chunk-production jitter can move a callback
receipt off the contract's shard.

**Derivation.** NEP-519 schedules the yielded callback receipt with
`receiver_id = <recipes contract>`. In NEAR's sharded execution
model, every receipt is executed on the shard that owns the
receiver's account — this is protocol-level, not a configuration
knob. The directly observable form of "receipt ran on the contract's
shard" in the RPC's `EXPERIMENTAL_tx_status` output is
`outcome.executor_id`, which is exactly the receiver that executed
the receipt. So:

1. The yield tx schedules the callback receipt on the contract's
   home shard.
2. When the resume tx fires (possibly signed by an account on a
   different shard), it produces an Action Receipt delivering the
   payload. That receipt is routed to the callback's shard before
   the callback executes.
3. The callback's own execution — where the trace logs are emitted —
   happens on the home shard, and `outcome.executor_id` reports the
   contract account.

On a multi-shard network (testnet observed at ~12 shards; mainnet
4–6 shards), cross-shard receipt forwarding is exercised precisely
when the resume-tx signer and the contract hash to different shards.
The invariant is what makes that cross-shard hop a correctness-
preserving operation: only the payload crosses the shard boundary,
the callback stays put.

**What we verify empirically.** For each callback-emitting receipt
outcome, `outcome.executor_id == <recipes contract>`. Under NEAR's
shard-per-receiver semantics, this is equivalent to "the callback
executed on the contract's home shard."

We don't rely on `chunk.receipts[]` to locate the callback receipt,
because yielded callbacks are delivered to their pre-scheduled
receipts from the protocol's yielded-receipts queue — not the
standard cross-shard routing path — so they don't appear in
`chunk.receipts[]` at execution time. They do, however, carry an
accurate `executor_id` in their outcome.

**How the contract's home shard is reported.** For transparency, the
audit also derives the home shard empirically from a receipt whose
chunk IS locatable — typically the initial `signer → contract`
action receipt from the yield tx, which appears in
`chunk.receipts[]` at delivery time. The report shows this shard
(e.g. "callbacks ran on contract shard 4") so the reader sees the
topology explicitly. This derived value is informational and does
not itself feed the held/failed decision.

**Consequence of violation.** A callback receipt with
`executor_id != <recipes contract>` would mean either:

- The runtime re-routed a yielded receipt to a different account (a
  protocol bug — should be impossible).
- The contract unexpectedly re-routed the callback via a nested
  cross-contract call (a contract bug — would also manifest as a
  DAG-placement violation).
- The audit's event-classification logic is wrong (a logic bug).

All three are "stop and look" events. In practice, the invariant has
held on every snapshotted testnet run.

**Where it's checked.**
[`scripts/src/audit.ts:computeShardPlacement`](../scripts/src/audit.ts).
For each callback-emitting trace event, compares
`outcome.executor_id` to the contract account. Per-run result stored
as `shardInvariant`; aggregated by `computeShardInvariant` in
`aggregate.ts`. Uses only data already captured in
`run-NN.onchain.json` — no additional RPC calls.

**Why this matters.** The DAG-placement invariant says "the yield tx
is the root of the receipt tree." Shard-placement says "the receipt
tree stays anchored to the contract's shard even when the tree's
input comes from a different shard." Together they pin down the
mental model that makes cross-shard yield/resume usage safe: the
*where* of a callback is determined once, at yield time, and nothing
in the resume path can move it.

## Why these four and not others

The four chosen invariants cover the four distinguishable claim
layers the repo makes:

- **Mechanic** — DAG-placement: "the yield tx is the root of the
  receipt tree."
- **Protocol** — Budget: "NEP-519's 200-block timeout is the
  observable reality, not just spec text."
- **Value** — Atomicity: "Recipe 4 actually moves the money."
- **Topology** — Shard-placement: "the receipt tree stays on the
  contract's shard regardless of where its input arrives from."

Candidates we considered and rejected:

- **Resume-propagates-payload.** Implicit in Recipe 1's Ok arm
  containing the resumed payload in its `outcome` string; adding a
  separate invariant would be bookkeeping without new signal.
- **Gas-prepaid-sufficient.** Worth tracking operationally, but it's
  a contract-level sizing concern rather than a spec-level claim.
  Gas budget drift would usually fail the callback loudly, not
  silently, so it has its own natural alarm.
- **YieldId-removed-on-resume.** A contract-internal state-management
  detail (`self.yields.remove(...)` happens before
  `yield_id.resume`), not an observable protocol property. Covered
  by unit tests in `contracts/recipes/`.

## Growing the set: Volume 2

If [`volume-2-intents.md`](volume-2-intents.md) ships, two more
invariants join the set:

- **Exactly-one-winner.** Per intent run, exactly one `solver_won`
  event; no intent adopts two solvers.
- **Cascade-fail ordering.** Every losing solver receives a
  `solver_lost` event in the same commit tx, before any downstream
  `intent_executing`. Prevents a losing solver from observing target
  state before the winner has been atomically selected.

Both are contention-specific; Volume 1 has no contention so they
don't apply yet. The infrastructure (`checkX` + `computeXInvariant` +
summary propagation + report rendering + CI grep) supports n
invariants; adding two more is additive.

## Testnet and where mainnet would strengthen the evidence

All four invariants are protocol-correctness claims — they should
hold on any NEAR network, regardless of validator set or traffic
level. The repo's testnet artifacts are the primary evidence.

A mainnet capture would add a second data point showing the same
claims hold under real validator load and real cross-shard receipt
forwarding. Shard-placement becomes particularly meaningful there:
cross-shard routing is exercised more often when the signer and
contract hash to different shards, and mainnet's smaller shard count
means a higher fraction of receipts actually cross shard boundaries.
(Currently out of scope for this repo — see the scope-discipline
section of `../CLAUDE.md` — but the invariant infrastructure is
network-agnostic and would apply without code changes.)
