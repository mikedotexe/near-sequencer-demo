# viz/common/ATTRIBUTION.md

All `*.py` files in this directory were vendored from the sibling repo:

- **Source**: `/Users/mikepurvis/near/manim-visualizations/common/`
- **Vendored on**: 2026-04-18
- **Sibling state**: un-versioned (no git commits yet), so the sibling
  source is pinned by the author's local working copy at the date
  above.

## What's vendored verbatim

| File | Size (lines) | Purpose |
|---|---|---|
| `__init__.py` | 1 | Marks `common/` as a package. |
| `background.py` | 108 | Cosmic-gradient background + starfield. |
| `blooms.py` | 159 | `settle_ok_bloom`, `eject_ring`, `downstream_tracer`, `decay_ember`, `decay_shockwave`. |
| `legend.py` | 102 | Colour / shape legend panel. |
| `palette.py` | 28 | Colour constants. |
| `satellite.py` | 399 | `Satellite` VGroup with orbit / budget-ring / settle / decay behaviours. |
| `sphere.py` | 260 | `LiquidContract` and `PersonActor` primitives. |
| `teach.py` | 90 | First-appearance vocabulary card. |
| `timeline.py` | 1256 | `TimelinePlayer` event dispatch + fatal invariants. |
| `typography.py` | 63 | `kerned_text` helper. |

These files depend on `manim`, `numpy` — no changes made on vendor.

## Extensions

An earlier incarnation of this repo carried extensions to the sibling
vocabulary (a `detached_spawn` / `detached_land` pair for detached
receipts, and a `SILENT_GREY` palette colour). Those extensions were
tied to the thesis-demo framing that this repo has since retired; the
recipe-book scenes use only sibling-vanilla event vocabulary
(`yield_eject`, `resume_data`, `resume_action`, `downstream_call`,
`downstream_return`, `settle`, `decay`, `tx_included`, `actor_appear`,
`narrative`). If the retired vocabulary is still present in the
vendored `timeline.py` / `palette.py`, it is unused by the current
scenes and may be dropped on a future re-sync.

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
# Re-apply this repo's extensions (palette + timeline detached_spawn).
# Or, cleaner: diff, merge manually, test renders.
```

No upstream automation — the vendored set is small enough that a human
review per sync is correct.
