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
| `satellite.py` | 329 | `Satellite` VGroup with orbit / budget-ring / settle / decay behaviours. |
| `sphere.py` | 260 | `LiquidContract` and `PersonActor` primitives. |
| `teach.py` | 90 | First-appearance vocabulary card. |
| `timeline.py` | 1130 | `TimelinePlayer` event dispatch + fatal invariants. |
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
