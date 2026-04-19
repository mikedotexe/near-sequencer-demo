# viz/common/ATTRIBUTION.md

All `*.py` files in this directory were vendored from the sibling repo:

- **Source**: `/Users/mikepurvis/near/manim-visualizations/common/`
- **Vendored on**: 2026-04-18
- **Sibling state**: un-versioned (no git commits yet), so the sibling
  source is pinned by the author's local working copy at the date
  above.

## What's vendored and pruned

| File | Size (lines) | Purpose |
|---|---|---|
| `__init__.py` | 1 | Marks `common/` as a package. |
| `background.py` | 108 | Cosmic-gradient background + starfield. |
| `blooms.py` | 159 | `settle_ok_bloom`, `eject_ring`, `downstream_tracer`, `decay_ember`, `decay_shockwave`. |
| `legend.py` | 102 | Colour / shape legend panel. |
| `palette.py` | 29 | Colour constants. |
| `satellite.py` | 399 | `Satellite` VGroup with orbit / budget-ring / settle / decay behaviours. |
| `sphere.py` | 310 | `LiquidContract` and `PersonActor` primitives. |
| `teach.py` | 90 | First-appearance vocabulary card. |
| `timeline.py` | 1556 | `TimelinePlayer` event dispatch + fatal invariants. |
| `typography.py` | 63 | `kerned_text` helper. |

The line counts above reflect the vendored copy after local pruning
(see next section); they are smaller than the sibling's current files.
These files depend on `manim`, `numpy`; otherwise unchanged on vendor.

## What was pruned on vendor

The sibling ships additional event vocabulary tied to its own scene set
that this recipe book doesn't use. On vendor we dropped it so stray
imports and dead-code branches don't confuse readers:

- `SILENT_GREY` / `SILENT_GREY_DEEP` colour constants (`palette.py`) —
  used only by the sibling's "Silent Message" scene.
- `detached_spawn` / `detached_land` event handlers (`timeline.py`) —
  the visuals for un-watched receipts that the sibling uses; the
  recipe book's four recipes never schedule a receipt the sequencer
  isn't tracking.

## Retained as Volume 2 scaffolding

The following handlers are present in `timeline.py` even though no
current (Volume 1) recipe emits them. They are *intentionally* kept as
the starting vocabulary for the next volume of recipes — a NEAR Intents
primer and the adapter / asserted policy patterns the sibling
`smart-account-contract` runs in production. See
[`../DESIGN.md`](../DESIGN.md) §"Volume 2 — Intents primer" for the
composition recipe that would exercise them.

- `visit_start` / `visit_complete` — active decision windows inside the
  200-block budget (solver deliberation, oracle consultation).
- `cascade_fail` — multi-winner contention (first-valid-solver; losing
  siblings resume cleanly with `PromiseError`).
- `inner_dispatch` / `inner_return` — adapter-chain courier: a
  FunctionCall with `.then(callback)` inside a yielded receipt where
  the callback verifies truthful results before resolving.
- `decay` — timeout as physical disintegration (ember + shockwave),
  distinct from the current `settle` with `status="timeout"` to enable
  near-miss storytelling at the 200-block boundary.
- `camera_focus` / `camera_restore` — authoring cinema tools for
  split-screen comparisons and time compression in longer narrated
  scenes.

Removing these is a one-line delete per handler if Volume 2 gets
descoped; keeping them costs ~260 lines of dormant code and avoids
re-vendoring the primitives from scratch later.

**Deadline:** [`../../docs/volume-2-intents.md`](../../docs/volume-2-intents.md)
commits to deleting these handlers by **2026-10-19** if Volume 2
hasn't been pursued by then. Check `git log --since=2026-04-19 --
viz/common/timeline.py docs/volume-2-intents.md` at that date; if the
log shows no substantive edits, pull the plug per that doc's removal
list.

## Why vendor rather than import cross-repo

1. **This repo renders standalone.** `git clone near-sequencer-demo &&
   cd viz && make recipe-basic` works without needing the sibling on
   the same machine.
2. **Pinning.** The sibling is in active iteration. Vendoring freezes
   a working baseline for this repo's scenes and lets us re-sync
   deliberately instead of chasing moving targets.
3. **Attribution is honest and small.** The files are a few hundred
   lines each; the sibling's design vocabulary (palette, orbital
   grammar, fatal invariants) is explicitly named and linked in
   `../DESIGN.md`.

## How to re-sync

```sh
# From the repo root:
rsync -av --delete \
  ../manim-visualizations/common/ \
  viz/common/ \
  --exclude ATTRIBUTION.md \
  --exclude __pycache__
# Then re-apply the prunings listed above so the vendored copy stays
# minimal; diff + merge manually if the sibling has added vocabulary
# this repo wants to adopt.
```

No upstream automation — the vendored set is small enough that a human
review per sync is correct.
