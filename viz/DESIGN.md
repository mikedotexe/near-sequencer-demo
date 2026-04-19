# viz/DESIGN.md — recipe-book animation design

Four Manim scenes, one per NEP-519 yield/resume recipe (basic, timeout,
chained, handoff). The scenes are driven by hand-authored synthetic
timelines for iteration + translator-generated live timelines from
real snapshots (testnet or mainnet), so the visual vocabulary of each
recipe renders the same way against both.

## Audiences

1. **Someone who hasn't read the contract source.** Can they watch
   20–40 seconds of one recipe scene and walk away with a working
   mental model of yield / resume / callback?
2. **Someone who has read the README.** Does the animation confirm
   the mechanic by showing the specific block-by-block beats the
   trace events record?

## Primitives — vendored from `manim-visualizations`

The viz/common/ layer (sphere, satellite, TimelinePlayer, palette,
blooms, teach cards, typography) is vendored from the sibling repo
[`/Users/mikepurvis/near/manim-visualizations`](../../../manim-visualizations).
See [`common/ATTRIBUTION.md`](common/ATTRIBUTION.md) for the source and
re-sync path. Two rules on that layer:

- **Don't weaken layout invariants.** The sibling enforces safe-frame,
  label-overflow, satellite-hygiene, and ephemera-leak as fatal
  assertions. A silent visual bug teaches the reader the wrong model;
  a loud render error forces the fix.
- **Don't fork vocabulary.** If a recipe needs a new event type, add
  it to the sibling repo first and re-sync. The four recipes here
  currently use only existing vocabulary (`yield_eject`, `resume_data`,
  `resume_action`, `downstream_call`, `downstream_return`, `settle`,
  `tx_included`, `actor_appear`, `narrative`).

## The four recipe scenes

| Recipe | Actors | Key visual beat |
|---|---|---|
| **Basic** | user, recipes | yielded satellite sits waiting; resume tx arrives; settle bloom. |
| **Timeout** | user, recipes | satellite yielded; long idle with block HUD ticking; settle with `status="timeout"` (red ember + shockwave). |
| **Chained** | user, recipes, counter | resume triggers `downstream_call` to counter; counter returns value via `downstream_return`; settle on recipes with status="ok". |
| **Handoff (claim)** | alice, recipes, bob | alice yields with 0.01 NEAR attached naming bob; resume fires; settle ok on recipes; the transfer receipt in the callback's DAG delivers funds to bob. |
| **Handoff (timeout)** | alice, recipes, bob | same 3-actor stage; alice yields naming bob; no resume; 200-block wait; settle timeout → Err-arm refund receipt to alice. Bob is present but silent to make the refund narratively clear. |

Note: in the current demo flow Alice signs both yield and resume. The
resume could be signed by Bob (the contract's `recipe_handoff_resume`
method is permissionless; wrapping it in an access-control check is a
one-liner), but testnet's ordering between two independent signers
sometimes races — Bob's tx can arrive before Alice's yield state is
visible and panic. Alice-signs-both keeps the value-transfer beat
clean; the scene's `resume` tx_included arrow comes from alice in both
the live and synthetic timelines.

All four reuse the same TimelinePlayer + primitives, just with
different event sequences + actor layouts.

### Invariant: no incoming tx at timeout settle

The timeout scene must NOT emit a `tx_included` (or any other incoming
arrow-flight event) at the settle block. The whole visual point of the
recipe is that the callback fires *with no external trigger* — the
satellite resolves on its own because the 200-block budget elapsed and
the runtime delivered `PromiseError` to the already-scheduled callback
receipt. A ghost tx at settle would teach the wrong model (suggesting a
second caller is required). The synthetic timeline and the live
translator both already respect this; if you're editing either, keep
the timeout settle standalone. Applies equally to Recipe 2 (timeout) and
Recipe 4 timeout-mode — the satellite settles alone in both.

### Invariant: Recipe 4's settle is on `recipes`, not on Bob

When Recipe 4's claim path ends, the `settle` event targets `recipes`
(green bloom on the contract sphere). The funds do flow to Bob in the
underlying receipt, but the visual language the sibling
`manim-visualizations` exposes today doesn't have a "value transfer
lands" primitive; dramatising the transfer with a `downstream_call` /
`downstream_return` pair risks conflating it with Recipe 3's explicit
cross-contract function call. If a richer value-ring primitive lands
upstream later, we can lean into it; until then the settle location is
deliberately on the contract, with the narrative card carrying the
"0.01 NEAR landed on Bob" beat.

## Event vocabulary

The events consumed by TimelinePlayer map to contract moments as
follows. See `common/timeline.py` for the handler implementations.

| Timeline event | What it shows | Recipe-book trigger |
|---|---|---|
| `actor_appear` | sphere fades in | once per actor, at scene start |
| `tx_included` | caller signs tx; lands on contract | each broadcast tx |
| `yield_eject` | satellite emerges on recipes sphere | `recipe_yielded` trace |
| `resume_data` / `resume_action` | resume payload arrives + fires | `recipe_resumed` trace |
| `downstream_call` | satellite flies from recipes → counter | `recipe_dispatched` trace (chained only) |
| `downstream_return` | satellite returns with value | `recipe_callback_observed` trace (chained only) |
| `settle` with status=ok | green bloom + shockwave; satellite fades | `recipe_resolved_ok` trace |
| `settle` with status=timeout | red ember + shockwave; satellite withers | `recipe_resolved_err` trace (timeout recipe) |
| `narrative` | teach-card overlay | opener + closer per scene |

## Synthetic vs live

Each recipe has two data files:

- `data/recipe-{name}-synthetic.json` — hand-authored, with pedagogical
  block spacing (e.g. the timeout scene compresses the 200-block wait
  into ~3.5 seconds of scene time via an aggressive `idle_block_seconds`).
- `data/recipe-{name}-live-NN.json` — translator output from a real
  testnet snapshot, regenerated via `scripts/onchain-to-timeline.mjs`.
  Block heights are the actual observed block heights; scene pacing
  falls out of `block_seconds * (last - first)`.

Each scene file exposes two classes, e.g. `RecipeBasic` (synthetic) and
`RecipeBasicLive` (live). They share a `build()` function that differs
only in the data file path.

## Actor layout

Per-scene `_LAYOUT` dict defines position for each actor. Keep positions
such that body bboxes + orbit radii don't overlap at the default
`orbit_radius=1.10`. The TimelinePlayer enforces no-overlap as a fatal
assertion; cramped layouts crash the render rather than letting actors
collide silently.

Captions (full account IDs) appear below each sphere. Keep display_name
short (max ~8 chars at sphere radius 0.52–0.62) to avoid
`LabelOverflowError` from `sphere.py`. Full account IDs go in the
`account_id` field, which renders as a caption under the sphere with
smaller font.

## Regenerating live timelines

```sh
cd viz/
./scripts/onchain-to-timeline.mjs \
    --raw ../artifacts/testnet/recipe-basic/run-01.raw.json \
    --out data/recipe-basic-live-01.json
manim -ql scenes/recipe_basic.py RecipeBasicLive
```

The translator reads the raw artifact + sibling `onchain.json`, walks
trace events from the snapshotted receipt DAGs, and emits a
TimelinePlayer-compatible JSON. It does not re-hit the network: every
block height below comes from the snapshot. See the translator source
for details on how yield-vs-resume tx DAGs are traversed to find each
trace event.

## Voice principle — vocabulary tracks the contract

Before coining a paraphrase in a narrative card or scene docstring,
grep the contract source. Prefer the actual method name
(`recipe_basic_yield`), NEP primitive (`Promise::new_yield`), and
trace event name (`recipe_resolved_ok`) over paraphrases. If NEAR
itself has no term for what you're trying to name, a coinage is fine —
otherwise, match the contract's own words.
