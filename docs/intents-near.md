# `intents.near` and what this repo shows that it doesn't

NEAR's production intents contract is deployed at
[`intents.near`](https://nearblocks.io/address/intents.near) (~7.8 TB
of storage, ~78 NEAR locked in the account at the time of writing).
It is the canonical on-chain surface for DIP-4 intent execution. When
we started evaluating whether this repo's NEP-519 invariant
infrastructure generalized to real production code, `intents.near`
was the first target.

It doesn't use NEP-519 yield/resume. That's the whole point of this
note — the contrast is the signal. This repo demonstrates a
composition pattern that `intents.near` isn't using: **contract-
controlled sequential receipt execution across block boundaries,
driven by `yield`/`resume`**.

## What `intents.near` actually does

Inspection of the 200 most recent txs on `intents.near` (around
mainnet block 194712XXX) showed three live patterns:

1. **Synchronous batch execution — `execute_intents` (45 txs / 200).**
   A relayer submits a batch of pre-signed DIP-4 intents and the
   contract processes the whole batch inside a single tx's DAG,
   emitting `dip4` events (`token_diff`, `transfer`,
   `intents_executed`) and settling all state changes atomically.

   Reference tx: [`6MxecZHFx2kbjLG2ne2rxVedCCxzw5AP2iWuiTCPEvBF`](https://nearblocks.io/txns/6MxecZHFx2kbjLG2ne2rxVedCCxzw5AP2iWuiTCPEvBF)
   at block 194712540. Two receipts — the main `execute_intents`
   call (12.6 Tgas, 6 logs, succeeded) and a gas-refund receipt —
   both on `intents.near`, both inside adjacent blocks. No long-
   running callback. No yielded receipt.

2. **`Promise.then()` chain — `ft_withdraw` → `ft_resolve_withdraw`
   (50 + 18 txs / 200).** When a user withdraws a fungible token,
   `intents.near` dispatches `ft_transfer` on the token contract and
   chains `.then(ft_resolve_withdraw)` to roll state back on failure.

   Reference tx: [`3hrjaXCAVVBC8Wr9jtn2T9LJ5xDwysLXwJtQcLy9M13i`](https://nearblocks.io/txns/3hrjaXCAVVBC8Wr9jtn2T9LJ5xDwysLXwJtQcLy9M13i).
   Three receipts, all in adjacent blocks — the withdraw call, the
   token contract's execution, and the resolve callback. This is
   classic NEAR callback chaining, structurally identical to our
   [`Recipe 3 (chained)`](../contracts/recipes/src/lib.rs) pattern
   **minus** the yield. No pause. No across-block span.

3. **NEP-141/NEP-245 receive-on-transfer callbacks** —
   `ft_on_transfer` (19), `mt_on_transfer` (6),
   `mt_batch_transfer_call` (6). Standard token-receiver patterns
   where `intents.near` is invoked as a callback target when
   someone sends tokens with a message. Synchronous within the
   calling tx's DAG.

No method on `intents.near` in this sample exhibited the yield/resume
signature — a receipt outcome executing significantly later than its
parent tx's block (the fingerprint of NEP-519's 200-block-budgeted
callback delivery).

## Two different answers to the same problem

Batching and yield/resume are both answers to *"how does a NEAR
contract coordinate multi-step work that can't happen in one atomic
synchronous call?"* They take different shapes.

| | `intents.near` (batching) | This repo (yield/resume) |
|---|---|---|
| **Primitive** | `execute_intents(Vec<SignedIntent>)` | `Promise::new_yield(callback, 200)` + `yield_id.resume(payload)` |
| **State across steps** | Not persisted — all work happens in one tx | Persisted in `yields: BTreeMap<String, YieldId>` + `handoffs: BTreeMap<String, HandoffMeta>` |
| **Time between steps** | Zero — all in one block | Unbounded up to the 200-block budget |
| **Who drives the next step** | The relayer, by constructing the batch | The resumer, by signing a resume tx — or the runtime, on timeout |
| **Latency** | Sub-second (one tx) | Seconds to minutes (one or more block spans) |
| **Atomicity** | All-or-nothing over the batch | Per-yield: callback always fires exactly once; atomic within the callback |
| **Flexibility** | Requires all state + signatures up-front | Contract can react to signals that didn't exist at yield time |
| **Observability** | One tx DAG, single block | Multiple tx DAGs spanning blocks; callback in yield-tx DAG |

Neither approach is "better." They solve different problems: batching
optimizes for throughput when the work is known at submission time;
yield/resume optimizes for flexibility when the contract needs to
*wait for signal* that arrives later.

## What "sequential receipt execution" means here

`intents.near`'s tx DAG is a tree rooted in one block. Every receipt
happens immediately after its parent. The contract's logic is
expressed as a single synchronous sequence of matcher rules.

This repo's yield-based recipes produce tx DAGs that span blocks.
When `recipe_basic_yield` fires, the contract schedules a callback
receipt and then stops — its state records a waiting YieldId and the
contract can service other txs. Blocks later, when `recipe_basic_resume`
arrives (or the 200-block budget elapses), the runtime delivers a
payload to the already-scheduled callback, which picks up execution
where the yield left off. Two transactions, one logical sequence.

The novel capability is not the fact that work is split across
blocks — classic `.then()` chains already do that. The novel
capability is that **the contract itself controls when to pause and
when to continue.** In a `.then()` chain the runtime drives the
continuation the moment the downstream receipt resolves. In
yield/resume, the contract says *"I will wait here until I am
resumed, for up to 200 blocks, with state guaranteed intact."* That
is a sequencing primitive, not a promise-chaining primitive.

Recipe 4 (handoff) is the clearest instance: value is escrowed in
contract state at yield time; the contract commits to release on
resume or refund on timeout; the resume tx can be signed by anyone,
and the funds land where the *yield-time* args said they should,
regardless of who pulled the trigger. That is only expressible because
the contract gets to dictate the pause-and-resume flow.

## Where the proof lives

The four machine-checked invariants in
[`invariants.md`](invariants.md) are the verification surface for the
claim that this pattern actually works on NEAR mainnet, not just in a
testnet sandbox:

- **DAG-placement** confirms the callback receipt lives in the yield
  tx's DAG, not the resume tx's — observable evidence that the
  runtime delivers payloads to already-scheduled receipts rather than
  creating new ones.
- **Budget** confirms the 200-block timeout fires within the spec'd
  window on mainnet (observed: 202 blocks, both networks, every run).
- **Atomicity** confirms Recipe 4's value transfer lands on the
  nominated recipient when resumed, with the correct amount, inside
  the callback — the economic demonstration of contract-controlled
  settlement.
- **Shard-placement** confirms the yielded callback receipt executes
  on the contract's home shard regardless of which shard the resume
  tx was signed from — the runtime is routing it back to where the
  YieldId was registered.

All four PASS on both testnet and mainnet, side-by-side in
[`../artifacts/comparative.md`](../artifacts/comparative.md). Four
independent verification paths (explorer, one-curl FastNEAR read,
offline re-audit, archival re-fetch) are in
[`verification.md`](verification.md).

## Could `intents.near` use yield/resume?

Nothing in its code would prevent it — NEP-519 is a protocol
primitive available to any contract. The fact that it doesn't use
yield/resume is a design choice, not a capability gap. `intents.near`
optimizes for the case where all solvers submit pre-signed work in a
single batch; yield/resume optimizes for the case where a contract
wants to pause and wait for a signal that doesn't exist yet.

If NEAR ever wanted to model an intent with an open bidding window
(N solvers racing for M blocks, with the contract adjudicating
exactly one winner inside the callback), yield/resume would be the
natural primitive. [`volume-2-intents.md`](volume-2-intents.md)
records that hypothetical as deferred work — not currently planned,
with an explicit trigger for when it might ship.

## Methodology

All claims above are grounded in live RPC queries against
`https://rpc.mainnet.fastnear.com` and
[`https://api.nearblocks.io`](https://api.nearblocks.io) on
2026-04-19 around mainnet block 194712500. The shape of intents.near
may evolve; if a future method group on the contract does use yield
or resume, the "it doesn't use NEP-519" claim becomes
history-of-2026-04-19 rather than present tense, and this doc should
be updated accordingly.
