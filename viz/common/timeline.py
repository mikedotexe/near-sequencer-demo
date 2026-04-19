"""Timeline-driven scene player.

A `TimelinePlayer` consumes the JSON event schema documented in
`README.md` and dispatches each event to a manim animation. The clock
is blocks, not seconds — every event carries a `block` field and the
player idles between events at `block_seconds` per block, so the
visible rhythm of the sequence matches the real 3-block retrieval cycle.

This player is intentionally small. Each handler is a pure function
that returns either an `Animation` (played at that block boundary),
a `(Animation, cleanup_callable)` tuple, or `None`.

It also enforces the invariants in `VISUAL_QA.md` — overlap, safe
frame, ephemera leak, satellite hygiene — as fatal assertions. A
silent visual bug teaches the reader the wrong model; a loud render
error forces the fix.
"""

from __future__ import annotations

import json
import os
from pathlib import Path
from typing import Any, Callable

import numpy as np
from manim import (
    Scene,
    Circle,
    DashedVMobject,
    Dot,
    RoundedRectangle,
    Text,
    VGroup,
    FadeIn,
    FadeOut,
    AnimationGroup,
    there_and_back,
    DOWN,
    RIGHT,
    WHITE,
)

from .palette import (
    SUCCESS_GREEN,
    TEXT_LIGHT,
    ORBIT_GUIDE,
    CONTRACT_TEAL,
    CONTRACT_STROKE,
    SATELLITE_AMBER,
    SATELLITE_AMBER_GLOW,
    SATELLITE_EDGE,
    FAILURE_RED,
)
from .sphere import LiquidContract, PersonActor
from .satellite import Satellite
from .legend import build_legend
from .blooms import (
    settle_ok_bloom,
    settle_shockwave,
    downstream_tracer,
    eject_ring,
)
from .teach import build_teach_card
from .typography import kerned_text, DEFAULT_FONT


# ----------------------------------------------------------------------
# Constants — see VISUAL_QA.md §1
# ----------------------------------------------------------------------

SAFE_FRAME_X = 6.8
SAFE_FRAME_Y = 3.8

HUD_RESERVED = (4.8, 6.8, -3.8, -3.1)  # (x_min, x_max, y_min, y_max)


class LayoutViolation(AssertionError):
    """Raised when a visual-QA layout invariant is broken."""


class LifecycleLeak(AssertionError):
    """Raised when a satellite / pulse leaked past its lifecycle."""


# ----------------------------------------------------------------------
# Loading
# ----------------------------------------------------------------------

def load_timeline(path: str | Path) -> dict:
    data = json.loads(Path(path).read_text())
    # Stable sort by (block, declared index).
    data["events"] = sorted(
        enumerate(data["events"]), key=lambda pair: (pair[1]["block"], pair[0])
    )
    data["events"] = [ev for _, ev in data["events"]]
    return data


# ----------------------------------------------------------------------
# Player
# ----------------------------------------------------------------------

class TimelinePlayer:
    def __init__(
        self,
        scene: Scene,
        timeline: dict,
        block_seconds: float = 0.55,
        idle_block_seconds: float | None = None,
        orbit_radius: float = 1.9,
        orbit_omega: float = 0.6,
        expected_remaining: set[str] | None = None,
        keyframe_sweep: bool | None = None,
        keyframe_dir: str | Path | None = None,
        background: str | None = None,
        pacing: float = 1.0,
    ):
        self.scene = scene
        self.timeline = timeline
        # `pacing` is a uniform tempo multiplier applied to block_seconds
        # and idle_block_seconds. 1.0 = scene's native rhythm (used by
        # standalone renders); higher values stretch every beat for
        # the shareable narrative tour. All scene.play run_times in
        # _play_batch inherit via block_seconds so the slowdown reaches
        # satellite travel, tracer arcs, blooms, and cascade beats
        # uniformly without per-call tuning.
        self.pacing = max(pacing, 1e-3)
        block_seconds = block_seconds * self.pacing
        self.block_seconds = block_seconds

        # Ambient backdrop — opt-in. "cosmic" = dark blue-black +
        # starfield. Applied BEFORE any content so stars sit at the
        # bottom of the z-stack by default.
        if background == "cosmic":
            from .background import apply_cosmic_background
            self._starfield = apply_cosmic_background(scene)
        else:
            self._starfield = None
        # Idle gaps between event blocks compress to `idle_block_seconds`
        # so a 40-block wait doesn't become dead air. Event-bearing
        # blocks still play at the full `block_seconds` rhythm so the
        # 3-block cascade chunk (resume/downstream/settle) reads
        # clearly.
        self.idle_block_seconds = (
            (idle_block_seconds * self.pacing) if idle_block_seconds is not None
            else block_seconds
        )
        # Silent-bug guard: a `scene.wait(s)` below one frame period
        # advances zero frames, meaning updaters (orbit rotation,
        # radius decay) don't fire at all. We don't know the scene's
        # frame rate until render time, but issue a warning for values
        # clearly below the default 15fps low-quality floor.
        if self.idle_block_seconds < 1.0 / 15.0:
            print(
                f"[TimelinePlayer] WARNING: idle_block_seconds="
                f"{self.idle_block_seconds:.3f}s is below 1/15fps = "
                f"0.067s. Orbit updaters may not fire during idle "
                f"ticks. Raise to >=0.08."
            )
        self.orbit_radius = orbit_radius
        self.orbit_omega = orbit_omega

        # Invariant: these labels MAY still be in orbit at scene end. All
        # others must have been drained via settle/decay.
        self.expected_remaining = expected_remaining or set()

        # Keyframe sweep controls. Env var flips it on from the CLI.
        if keyframe_sweep is None:
            keyframe_sweep = os.environ.get("KEYFRAME_SWEEP", "") == "1"
        self.keyframe_sweep = keyframe_sweep
        self.keyframe_dir = Path(
            keyframe_dir
            or Path("media") / "keyframes" / scene.__class__.__name__
        )
        if self.keyframe_sweep:
            self.keyframe_dir.mkdir(parents=True, exist_ok=True)

        # State — populated by place_actors.
        self.actors: dict[str, Any] = {}
        self.satellites: dict[str, Satellite] = {}
        self._ephemera: set = set()  # pulses etc. awaiting removal
        self._ejection_blocks: dict[str, int] = {}
        self._yield_budget_blocks = int(timeline.get("yield_budget_blocks", 200))
        self._seen_event_types: set[str] = set()
        self._callouts_enabled = True
        # Actors whose `visible_at_start` is false — placed in
        # `self.actors` but not yet `scene.add`ed. An `actor_appear`
        # event is what brings them on screen.
        self._deferred_actors: set[str] = set()

        # Orbit guides — dashed faint rings that appear under any contract
        # with a live satellite. Reference-counted per actor_id so the
        # guide is drawn once (first eject) and removed when the last
        # satellite exits. Purely ambient; no invariant depends on them.
        self._orbit_guides: dict[str, DashedVMobject] = {}
        self._orbit_guide_refs: dict[str, int] = {}

        # Block clock HUD.
        self._hud_group = None
        self._hud_anchor = None
        self._current_block = int(timeline["block_origin"])

    # ------------------------------------------------------------------
    # Setup
    # ------------------------------------------------------------------

    def place_actors(self, layout: dict[str, Any]):
        """`layout` maps actor_id -> manim position (list[3] or ndarray)."""
        for actor_id, spec in self.timeline["actors"].items():
            if actor_id not in layout:
                raise LayoutViolation(
                    f"actor {actor_id!r} declared in timeline but missing from layout"
                )
            pos = np.array(layout[actor_id], dtype=float)
            kind = spec.get("kind", "liquid")
            if kind == "liquid":
                # Optional per-actor overrides let Pet Shop ship small
                # pet sub-contracts (radius ~0.45) alongside the main
                # shop without a new primitive.
                contract_kwargs: dict[str, Any] = {}
                if "radius" in spec:
                    contract_kwargs["radius"] = float(spec["radius"])
                if "display_font_size" in spec:
                    contract_kwargs["display_font_size"] = int(spec["display_font_size"])
                if "caption_font_size" in spec:
                    contract_kwargs["caption_font_size"] = int(spec["caption_font_size"])
                mob = LiquidContract(
                    display_name=spec.get("display_name") or spec.get("label", actor_id),
                    account_id=spec.get("account_id") or spec.get("label", actor_id),
                    **contract_kwargs,
                )
                # Push caption outside the orbital zone so south-phase
                # satellites don't overlap the account_id text.
                # `orbit_radius + sat_radius + margin` is the clearance.
                mob.place_caption_below(self.orbit_radius + 0.35)
            else:
                person_kwargs: dict[str, Any] = {}
                if "radius" in spec:
                    person_kwargs["radius"] = float(spec["radius"])
                if "font_size" in spec:
                    person_kwargs["font_size"] = int(spec["font_size"])
                if "text_color" in spec:
                    person_kwargs["text_color"] = spec["text_color"]
                mob = PersonActor(spec.get("label", actor_id), **person_kwargs)
            mob.move_to(pos)
            self.actors[actor_id] = mob
            # `visible_at_start: false` defers `scene.add` until an
            # `actor_appear` event fires. Positions are still asserted
            # in the safe-frame / overlap checks below so we know the
            # layout is valid before any reveals run.
            if spec.get("visible_at_start", True):
                self.scene.add(mob)
            else:
                self._deferred_actors.add(actor_id)

        self._assert_inside_safe_frame()
        self._assert_no_actor_overlap()

    def add_block_hud(self, corner=None):
        """Block HUD is stacked: big relative offset (+N since origin)
        on top, smaller absolute block number below. The relative
        number is what's pedagogically meaningful — block 246228993 is
        noise on its own, but "+59" tells you this is the 59th block
        since the batch landed.
        """
        if corner is None:
            corner = np.array([5.6, -3.35, 0.0])
        self._hud_anchor = np.array(corner, dtype=float)
        self._hud_group = self._build_hud_text(self._current_block)
        self._hud_group.move_to(self._hud_anchor)
        self.scene.add(self._hud_group)

    def _build_hud_text(self, block: int):
        offset = block - self.timeline["block_origin"]
        relative = kerned_text(f"+{offset}", font_size=26, color=TEXT_LIGHT)
        absolute = kerned_text(f"block {block}", font_size=12, color=TEXT_LIGHT)
        absolute.next_to(relative, direction=np.array([0.0, -1.0, 0.0]), buff=0.08)
        absolute.align_to(relative, np.array([1.0, 0.0, 0.0]))
        stack = VGroup(relative, absolute)
        # Panel around the stack so the HUD reads as a UI element
        # against the starfield / orbit guides instead of floating
        # numbers. Matches the legend's visual language.
        pad_x, pad_y = 0.22, 0.14
        panel = RoundedRectangle(
            width=stack.width + 2 * pad_x,
            height=stack.height + 2 * pad_y,
            corner_radius=0.12,
            color=CONTRACT_STROKE,
            fill_color=CONTRACT_TEAL,
            fill_opacity=0.12,
            stroke_width=1.0,
            stroke_opacity=0.32,
        )
        panel.move_to(stack.get_center())
        return VGroup(panel, stack)

    # ------------------------------------------------------------------
    # Layout invariants — VISUAL_QA.md §1
    # ------------------------------------------------------------------

    def _assert_inside_safe_frame(self):
        for actor_id, mob in self.actors.items():
            xmin, xmax, ymin, ymax = mob.body_bbox()
            if xmin < -SAFE_FRAME_X or xmax > SAFE_FRAME_X:
                raise LayoutViolation(
                    f"actor {actor_id!r} body x-range [{xmin:.2f},{xmax:.2f}] "
                    f"exits safe frame x=±{SAFE_FRAME_X}"
                )
            if ymin < -SAFE_FRAME_Y or ymax > SAFE_FRAME_Y:
                raise LayoutViolation(
                    f"actor {actor_id!r} body y-range [{ymin:.2f},{ymax:.2f}] "
                    f"exits safe frame y=±{SAFE_FRAME_Y}"
                )

    def _assert_no_actor_overlap(self):
        items = list(self.actors.items())
        for i, (id_a, a) in enumerate(items):
            ax0, ax1, ay0, ay1 = a.body_bbox()
            for id_b, b in items[i + 1 :]:
                bx0, bx1, by0, by1 = b.body_bbox()
                overlap_x = (ax0 < bx1) and (bx0 < ax1)
                overlap_y = (ay0 < by1) and (by0 < ay1)
                if overlap_x and overlap_y:
                    raise LayoutViolation(
                        f"actor body bounding boxes overlap: "
                        f"{id_a!r} [{ax0:.2f},{ax1:.2f}]×[{ay0:.2f},{ay1:.2f}] "
                        f"vs {id_b!r} [{bx0:.2f},{bx1:.2f}]×[{by0:.2f},{by1:.2f}]"
                    )

    # ------------------------------------------------------------------
    # Main loop
    # ------------------------------------------------------------------

    def play(self):
        events = self.timeline["events"]
        i = 0
        while i < len(events):
            block = events[i]["block"]
            if block > self._current_block:
                self._tick_blocks(block - self._current_block)
            batch: list[dict] = []
            while i < len(events) and events[i]["block"] == block:
                batch.append(events[i])
                i += 1
            self._play_batch(batch)
            self._save_keyframe(block)

        # Lifecycle invariants — §2.
        self._assert_no_ephemera_leaked()
        self._assert_satellite_hygiene()

    def _tick_blocks(self, n_blocks: int):
        for _ in range(n_blocks):
            self._set_block(self._current_block + 1)
            if self.keyframe_sweep:
                # Idle blocks still get a frame, so the storyboard shows orbit motion.
                self.scene.wait(self.idle_block_seconds)
                self._save_keyframe(self._current_block, tag="idle")
            else:
                self.scene.wait(self.idle_block_seconds)

    def _set_block(self, new_block: int):
        self._current_block = new_block
        self._refresh_budgets()
        self._gc_callouts()
        if getattr(self, "_hud_group", None) is None:
            return
        new_hud = self._build_hud_text(new_block)
        new_hud.move_to(self._hud_anchor)
        self.scene.remove(self._hud_group)
        self.scene.add(new_hud)
        self._hud_group = new_hud

    def _refresh_budgets(self):
        """Update each satellite's budget tracker based on blocks
        elapsed since its ejection. Called whenever the block counter
        ticks. The ring redraws continuously via always_redraw so no
        explicit play() call is needed.
        """
        for label, sat in self.satellites.items():
            ejected = self._ejection_blocks.get(label)
            if ejected is None:
                continue
            elapsed = self._current_block - ejected
            remaining = max(0, self._yield_budget_blocks - elapsed)
            frac = remaining / self._yield_budget_blocks
            sat.budget_tracker.set_value(frac)

    def add_legend(self, corner=None):
        """Opt-in persistent legend on the left edge."""
        legend = build_legend()
        if corner is None:
            corner = np.array([-6.6, 1.5, 0.0])
        legend.move_to(corner, aligned_edge=np.array([-1.0, 1.0, 0.0]))
        self.scene.add(legend)
        self._legend = legend

    # ------------------------------------------------------------------
    # First-appearance callouts — teach the vocabulary once.
    # ------------------------------------------------------------------

    # Teach card per event type — (title, body). Shown at the top of
    # the scene the first time a given type fires. Body text names the
    # contract method, NEP-519 constant, or decision point the event
    # maps to, so a NEAR engineer encountering these primitives for
    # the first time sees the full mapping, not just a paraphrase of
    # the event name.
    _TEACH_CARDS = {
        "tx_included":       ("tx_included",
                              "User signs a call; a receipt lands on the contract."),
        "yield_eject":       ("yield_eject — yield_promise",
                              "Contract yields a promise; NEP-519 gives it a 200-block budget."),
        "resume_data":       ("resume_data",
                              "resume_sequence delivers the payload back to the callback."),
        "resume_action":     ("resume_action — on_promise_resumed",
                              "The callback runs on the contract, dispatching downstream work."),
        "downstream_call":   ("downstream_call",
                              "The callback's FunctionCall travels to its target contract."),
        "downstream_return": ("downstream_return",
                              "The target contract returns a result via a Data receipt."),
        "settle":            ("settle — on_promise_resolved",
                              "Final callback runs with the downstream outcome; yielded promise resolved."),
        "budget_numeral":    ("budget_numeral",
                              "Remaining blocks of the NEP-519 200-block budget, counting down as blocks elapse."),
    }

    _TEACH_KEEP_ALIVE_BLOCKS = 3   # short dwell so stack stays bounded
    _TEACH_TOP_Y = 2.92            # below scene title (~y=3.4), above action (<=y=1.5)
    _TEACH_ROW_SPACING = 0.68      # two-line card height + a hair
    _TEACH_MAX_SLOTS = 2           # hard cap — any more would overlap contracts

    def _maybe_callout(self, ev_type: str):
        """If this event type is new in the scene, stage a teach card
        at the top of the frame. At most `_TEACH_MAX_SLOTS` cards are
        visible at once — when the cap is hit, the oldest vocab card is
        evicted and the newcomer takes its slot. Narrative cards (the
        `narrative` event type) are protected from vocab eviction.

        Doesn't return a FadeIn. Instead, marks the card `needs_fadein`
        in `_callouts_pending`; `_play_batch` builds the FadeIn *after*
        the dispatch loop completes, so cards evicted mid-batch are
        never scene-added (their pending entry was already popped). If
        the FadeIn were built here, an evicted card's animation would
        still be queued and the card would appear anyway, piling up at
        its old slot on top of the slot-taker.
        """
        if not self._callouts_enabled:
            return
        if ev_type in self._seen_event_types:
            return
        entry = self._TEACH_CARDS.get(ev_type)
        if entry is None:
            return
        title, body = entry
        self._seen_event_types.add(ev_type)
        card = build_teach_card(title, body, kind="definition")
        pending = getattr(self, "_callouts_pending", [])

        occupied_slots = {item[3] for item in pending}
        free_slot = next(
            (i for i in range(self._TEACH_MAX_SLOTS) if i not in occupied_slots),
            None,
        )
        if free_slot is None:
            # Narrative cards are protected from vocab eviction — they
            # carry the thesis, not a definition. If every slot is held
            # by a narrative card, skip this vocab rather than stomp
            # the thesis.
            vocab_indices = [
                i for i, item in enumerate(pending)
                if not item[1].get("is_narrative", False)
            ]
            if not vocab_indices:
                return
            evict_idx = vocab_indices[0]  # oldest vocab (list is FIFO)
            oldest = pending.pop(evict_idx)
            oldest_mob = oldest[0]
            free_slot = oldest[3]
            # If the evicted mob is already on screen (from a prior
            # block's FadeIn), remove it now. If it was queued in the
            # current batch but never FadeIn'd, this is a no-op and
            # the `_play_batch` FadeIn pass skips it because it's no
            # longer in `_callouts_pending`.
            if oldest_mob in self.scene.mobjects:
                self.scene.remove(oldest_mob)

        y = self._TEACH_TOP_Y - free_slot * self._TEACH_ROW_SPACING
        card.move_to(np.array([0.0, y, 0.0]))
        pending.append((  # noqa: this is a 4-tuple — see _gc_callouts
            card,
            {"keep_alive_blocks": self._TEACH_KEEP_ALIVE_BLOCKS,
             "is_narrative": False,
             "needs_fadein": True},
            self._current_block,
            free_slot,
        ))
        self._callouts_pending = pending

    def _gc_callouts(self):
        """Remove teach cards whose keep-alive window has passed."""
        pending = getattr(self, "_callouts_pending", [])
        if not pending:
            return
        still_pending = []
        to_fade = []
        for entry in pending:
            mob, token, spawned, slot = entry
            if self._current_block - spawned >= token["keep_alive_blocks"]:
                to_fade.append(mob)
            else:
                still_pending.append(entry)
        self._callouts_pending = still_pending
        # Instant removal — each card has already had its keep-alive
        # window. An explicit FadeOut here would stretch the idle tick
        # by the animation time; cards already faded IN, that's enough.
        for mob in to_fade:
            if mob in self.scene.mobjects:
                self.scene.remove(mob)

    def _play_batch(self, batch: list[dict]):
        anims = []
        post_actions: list[Callable] = []
        for ev in batch:
            self._maybe_callout(ev["type"])
            result = self._dispatch(ev)
            if result is None:
                continue
            if isinstance(result, tuple):
                anim, cb = result
                if anim is not None:
                    anims.append(anim)
                if cb is not None:
                    post_actions.append(cb)
            else:
                anims.append(result)
        # Build FadeIns for any cards that survived to this point.
        # Cards evicted mid-batch are no longer in `_callouts_pending`
        # so their FadeIn is never queued — that's the whole point of
        # deferring this pass to after dispatch.
        pending = getattr(self, "_callouts_pending", [])
        for entry in pending:
            card, token, spawned, _slot = entry
            if token.get("needs_fadein") and spawned == self._current_block:
                anims.append(FadeIn(card, run_time=0.35))
                token["needs_fadein"] = False
        if anims:
            self.scene.play(*anims, run_time=self.block_seconds)
        else:
            self.scene.wait(self.block_seconds * 0.4)
        for cb in post_actions:
            cb()

    def _save_keyframe(self, block: int, tag: str = "event"):
        if not self.keyframe_sweep:
            return
        # Use manim's frame writer to emit a PNG of the current frame.
        try:
            fw = self.scene.renderer.file_writer
            img = self.scene.renderer.get_frame()
            out = self.keyframe_dir / f"block_{block:05d}_{tag}.png"
            from PIL import Image
            Image.fromarray(img).save(out)
        except Exception as exc:  # noqa: BLE001
            # Non-fatal — keyframe sweep is a debugging aid, not a correctness path.
            print(f"[keyframe_sweep] failed at block {block}: {exc}")

    # ------------------------------------------------------------------
    # Lifecycle invariants — VISUAL_QA.md §2
    # ------------------------------------------------------------------

    def _register_ephemeron(self, mob):
        self._ephemera.add(id(mob))

    def _deregister_ephemeron(self, mob):
        self._ephemera.discard(id(mob))

    def _assert_no_ephemera_leaked(self):
        if self._ephemera:
            raise LifecycleLeak(
                f"{len(self._ephemera)} ephemeral mobject(s) were never cleaned up. "
                f"Check that every dispatch handler that creates a pulse also "
                f"returns a cleanup callback."
            )

    def _assert_satellite_hygiene(self):
        remaining = set(self.satellites.keys())
        unexpected = remaining - self.expected_remaining
        if unexpected:
            raise LifecycleLeak(
                f"satellite(s) {sorted(unexpected)} survived to scene end but "
                f"were not in expected_remaining={sorted(self.expected_remaining)}. "
                f"Add a settle/decay event or update expected_remaining."
            )
        missing_from_expected = self.expected_remaining - remaining
        if missing_from_expected:
            raise LifecycleLeak(
                f"expected_remaining={sorted(self.expected_remaining)} includes "
                f"label(s) {sorted(missing_from_expected)} that are not in orbit at scene end."
            )

    # ------------------------------------------------------------------
    # Event dispatch
    # ------------------------------------------------------------------

    def _dispatch(self, ev: dict):
        handler = {
            "tx_included":          self._ev_tx_included,
            "yield_eject":          self._ev_yield_eject,
            "resume_data":          self._ev_resume_data,
            "resume_action":        self._ev_resume_action,
            "downstream_call":      self._ev_downstream_call,
            "downstream_return":    self._ev_downstream_return,
            "settle":               self._ev_settle,
            "budget_numeral":       self._ev_budget_numeral,
            "budget_numeral_hide":  self._ev_budget_numeral_hide,
            "actor_appear":         self._ev_actor_appear,
            "narrative":            self._ev_narrative,
            "pending":              lambda _ev: None,
        }.get(ev["type"])
        if handler is None:
            return None
        return handler(ev)

    # ---- handlers ----------------------------------------------------

    def _spawn_pulse(self, at, color=WHITE, radius=0.09):
        """A glow pulse = 3 concentric filled circles. Outer halo gives
        it a soft aura; inner halo is the body; core is a bright seed.
        Animates / cleans up as a single VGroup — callers are unchanged.
        """
        outer = Circle(
            radius=radius * 1.40, color=color, fill_color=color,
            fill_opacity=0.14, stroke_width=0,
        )
        inner = Circle(
            radius=radius * 1.00, color=color, fill_color=color,
            fill_opacity=0.38, stroke_width=0,
        )
        core = Circle(
            radius=radius * 0.55, color=color, fill_color=color,
            fill_opacity=0.95, stroke_width=0,
        )
        pulse = VGroup(outer, inner, core)
        pulse.move_to(at)
        self.scene.add(pulse)
        self._register_ephemeron(pulse)
        return pulse

    def _kill_pulse(self, pulse):
        self.scene.remove(pulse)
        self._deregister_ephemeron(pulse)

    # ---- orbit guides (T2) ------------------------------------------

    def _ensure_orbit_guide(self, actor_id: str):
        """Ensure a dashed orbit-path guide is live for this contract.

        Returns a `FadeIn` animation if a new guide was created, else
        `None`. Callers compose the returned animation into their
        yield_eject AnimationGroup so the fade-in rides along with
        the first satellite's ejection from centre.
        """
        if actor_id in self._orbit_guides:
            self._orbit_guide_refs[actor_id] += 1
            return None
        parent = self.actors[actor_id]
        # Build the dashed ring by stamping short arcs around the circle.
        # Manim's DashedVMobject wrapper sometimes loses stroke on CE
        # 0.20 for closed paths; hand-built arcs are more predictable.
        from manim import Arc, VGroup as _VGroup, PI, TAU
        n_dashes = 42
        guide = _VGroup()
        for k in range(n_dashes):
            start = (k / n_dashes) * TAU
            sweep = (0.5 * TAU) / n_dashes   # 50% duty cycle
            arc = Arc(
                radius=self.orbit_radius,
                start_angle=start,
                angle=sweep,
                color=ORBIT_GUIDE,
                stroke_width=1.8,
                stroke_opacity=0.55,
            )
            guide.add(arc)
        guide.move_to(parent.center())
        self.scene.add(guide)
        # Send to back so satellites / pulses render above it.
        self.scene.bring_to_back(guide)
        self._orbit_guides[actor_id] = guide
        self._orbit_guide_refs[actor_id] = 1

        # Shimmer: opacity pulses gently ±0.15 over ~3s. Makes the
        # dashed ring feel alive rather than a static HUD overlay.
        # Phase offset per actor so multi-contract scenes don't
        # synchronise.
        shimmer_phase = [float(hash(actor_id) % 1000) / 100.0]
        shimmer_base = 0.55

        def _shimmer(_mob, dt):
            shimmer_phase[0] += dt
            factor = 0.15 * np.sin(shimmer_phase[0] * (2 * np.pi / 3.0))
            op = max(0.15, min(0.85, shimmer_base + factor))
            for arc in _mob:
                arc.set_stroke(opacity=op)

        guide.add_updater(_shimmer)
        return FadeIn(guide, run_time=0.3)

    def _orbit_guide_fade_on_release(self, actor_id: str):
        """Peek at the refcount — if this release will drop it to 0,
        return a FadeOut animation. Caller composes this with settle /
        decay. The actual mobject removal happens in cleanup so the
        fade animation has something to animate on."""
        if actor_id not in self._orbit_guide_refs:
            return None
        if self._orbit_guide_refs[actor_id] - 1 <= 0:
            return FadeOut(self._orbit_guides[actor_id], run_time=0.3)
        return None

    def _release_orbit_guide(self, actor_id: str):
        if actor_id not in self._orbit_guide_refs:
            return
        self._orbit_guide_refs[actor_id] -= 1
        if self._orbit_guide_refs[actor_id] <= 0:
            guide = self._orbit_guides.pop(actor_id)
            del self._orbit_guide_refs[actor_id]
            if guide in self.scene.mobjects:
                self.scene.remove(guide)

    def _ev_tx_included(self, ev):
        src = self.actors[ev["actor"]]
        dst = self.actors[ev["target"]]
        pulse = self._spawn_pulse(src.center())

        def cleanup():
            self._kill_pulse(pulse)

        wobble = dst.wobble() if hasattr(dst, "wobble") else FadeIn(pulse, scale=1.0)
        anim = AnimationGroup(
            pulse.animate.move_to(dst.center()),
            wobble,
            lag_ratio=0.35,
        )
        return anim, cleanup

    def _ev_yield_eject(self, ev):
        contract = self.actors[ev["actor"]]
        # `step_id` is the on-chain identifier (contract field name in
        # YieldedPromise); the satellite's visible tag text happens to be
        # the same string, but the concepts are separate — `step_id`
        # indexes our state, and the Satellite label is its typography.
        step_id = ev["step_id"]
        if step_id in self.satellites:
            raise LifecycleLeak(
                f"yield_eject for step_id {step_id!r} but that satellite is already in orbit"
            )
        n_existing = len(self.satellites)
        angle0 = n_existing * (2.0 * np.pi / 4.0)
        sat = Satellite(step_id)
        sat.move_to(contract.center())
        self.scene.add(sat)
        # Trail dots are independent mobjects (live in absolute coords)
        # so orbit motion doesn't drag them. Send behind the satellite.
        for dot in sat.trail_dots:
            self.scene.add(dot)
            self.scene.bring_to_back(dot)
        sat.attach_orbit(
            contract,
            initial_radius=0.0,
            angular_speed=self.orbit_omega,
            initial_angle=angle0,
        )
        self.satellites[step_id] = sat
        self._ejection_blocks[step_id] = self._current_block
        # Budget ring — always_redraw makes it follow the satellite
        # around its orbit and recolour as the budget drops.
        ring = sat.make_budget_ring()
        self.scene.add(ring)

        # Orbit guide fades in alongside the first ejection for this
        # contract; subsequent ejections just bump the refcount.
        guide_fade = self._ensure_orbit_guide(ev["actor"])

        # Launch pulse — a thin amber ring leaves the parent's surface
        # and expands to the orbit radius, fading as it goes. Ambient;
        # tracked as ephemeron so hygiene bites if cleanup is missed.
        parent_radius = getattr(contract, "_radius", 0.8)
        eject_ring_mob, eject_ring_anim = eject_ring(
            contract.center(),
            start_radius=parent_radius,
            end_radius=self.orbit_radius,
        )
        self.scene.add(eject_ring_mob)
        self._register_ephemeron(eject_ring_mob)

        decay_blocks = ev.get("decay_over_blocks")
        if decay_blocks:
            # After the ejection anim, start a continuous decay so the
            # orbit visibly shrinks as the yield budget burns. The
            # `final_fraction` is a pedagogy choice — going all the way
            # to 0 would make the satellite collide with the contract
            # before the decay event fires; 0.25 × orbit_radius leaves
            # a readable gap until the disintegration flash.
            target = self.orbit_radius * float(ev.get("decay_final_fraction", 0.25))
            # Calibrate the shrink rate to the *compressed* playback
            # tempo — decay happens during idle stretches, so the
            # updater has to match idle_block_seconds to cover the full
            # radial delta across the visible wall-clock window.
            duration = decay_blocks * self.idle_block_seconds
            # Schedule via a post-animation callback.
            def start_shrink():
                sat.start_yield_decay(duration_seconds=duration, target_radius=target)

            anim = sat.radius_tracker.animate.set_value(self.orbit_radius)
            group_anims = [anim, eject_ring_anim]
            if guide_fade is not None:
                group_anims.insert(0, guide_fade)
            combined = AnimationGroup(*group_anims)

            def combined_cleanup():
                start_shrink()
                if eject_ring_mob in self.scene.mobjects:
                    self.scene.remove(eject_ring_mob)
                self._deregister_ephemeron(eject_ring_mob)

            return combined, combined_cleanup

        eject_anim = sat.radius_tracker.animate.set_value(self.orbit_radius)
        group_anims = [eject_anim, eject_ring_anim]
        if guide_fade is not None:
            group_anims.insert(0, guide_fade)
        combined = AnimationGroup(*group_anims)

        def ring_cleanup():
            if eject_ring_mob in self.scene.mobjects:
                self.scene.remove(eject_ring_mob)
            self._deregister_ephemeron(eject_ring_mob)

        return combined, ring_cleanup

    def _ev_resume_data(self, ev):
        contract = self.actors[ev["actor"]]
        sat = self.satellites.get(ev["step_id"])
        if sat is None:
            return None
        pulse = self._spawn_pulse(contract.center(), color=SUCCESS_GREEN, radius=0.08)
        target = sat.get_center()

        def cleanup():
            self._kill_pulse(pulse)

        return pulse.animate.move_to(target), cleanup

    def _ev_resume_action(self, ev):
        contract = self.actors[ev["actor"]]
        sat = self.satellites.get(ev["step_id"])
        anims = [contract.wobble()]
        if sat is not None:
            anims.append(sat.body.animate(rate_func=there_and_back).scale(1.25))
        return AnimationGroup(*anims, lag_ratio=0.1)

    def _ev_downstream_call(self, ev):
        sat = self.satellites.get(ev["step_id"])
        actor = self.actors[ev["actor"]]
        target = self.actors[ev["target"]]
        if sat is None:
            return None
        sat.detach_orbit()

        target_point = target.center() + np.array([0.0, 0.55, 0.0])
        # Persistent amber arc from the calling contract to its target.
        # Lingers ~0.85s while fading — communicates "a FunctionCall
        # receipt travelled this path", distinct from the satellite
        # itself (which represents the yielded callback).
        tracer, tracer_anim = downstream_tracer(actor.center(), target_point)
        self.scene.add(tracer)
        self._register_ephemeron(tracer)

        # Focal ring — a dashed amber ring that surrounds the satellite
        # while it's parked at its target, reading as "this satellite is
        # watching its receipt." Distinguishes the parked yielded callback
        # (amber body + dashed ring = attention) from an ordinary
        # FunctionCall receipt that doesn't persist.
        focal_ring = self._build_focal_ring(target_point)

        anim = AnimationGroup(
            sat.animate.move_to(target_point),
            target.wobble(),
            tracer_anim,
            FadeIn(focal_ring, run_time=self.block_seconds * 0.6),
            lag_ratio=0.3,
        )

        def cleanup():
            if tracer in self.scene.mobjects:
                self.scene.remove(tracer)
            self._deregister_ephemeron(tracer)
            # Attach focal ring to satellite AFTER the travel completes
            # so its cleanup paths (downstream_return / settle) can find
            # and retire it. We add it to the scene *before* the anim
            # (so FadeIn has something to animate), but park the reference
            # here because its lifecycle is sat-scoped.
            sat._focal_ring = focal_ring
            sat._focal_ring_cleanup = self._attach_focal_shimmer(focal_ring)

        return anim, cleanup

    def _build_focal_ring(self, center, radius: float = 0.40):
        """Dashed amber ring for the 'parked satellite is watching' beat.
        Built as a VGroup of short Arcs (same technique the orbit guide
        uses) so CE 0.20's DashedVMobject quirks on closed paths don't
        bite. Added to the scene with opacity 0; the caller's FadeIn
        brings it in."""
        from manim import Arc, VGroup as _VGroup, TAU
        n_dashes = 24
        guide = _VGroup()
        for k in range(n_dashes):
            start = (k / n_dashes) * TAU
            sweep = (0.55 * TAU) / n_dashes   # ~55% duty cycle — tighter than orbit guide
            arc = Arc(
                radius=radius,
                start_angle=start,
                angle=sweep,
                color=SATELLITE_AMBER,
                stroke_width=1.8,
                stroke_opacity=0.0,   # FadeIn will push this up
            )
            guide.add(arc)
        guide.move_to(np.array(center, dtype=float))
        self.scene.add(guide)
        # Below the satellite so the satellite body reads in front.
        self.scene.bring_to_back(guide)
        self._register_ephemeron(guide)
        return guide

    def _attach_focal_shimmer(self, ring):
        """Gentle breathing: opacity pulses ±0.15 around 0.55 over ~2.4s.
        Signals 'live attention' rather than a static ring.
        Returns a teardown callable the caller can invoke on removal."""
        phase = [0.0]
        base = 0.55
        amp = 0.15
        period = 2.4

        def _shimmer(_mob, dt):
            phase[0] += dt
            factor = amp * np.sin(phase[0] * (2 * np.pi / period))
            op = max(0.25, min(0.90, base + factor))
            for arc in _mob:
                arc.set_stroke(opacity=op)

        ring.add_updater(_shimmer)

        def teardown():
            ring.remove_updater(_shimmer)

        return teardown

    def _ev_downstream_return(self, ev):
        src = self.actors[ev["actor"]]
        dst = self.actors[ev["target"]]
        sat = self.satellites.get(ev["step_id"])
        pulse = self._spawn_pulse(src.center(), color=SUCCESS_GREEN, radius=0.08)

        # If the satellite has a focal ring parked at `src`, fade it out
        # as the satellite detaches. Shimmer updater is torn down first
        # so FadeOut isn't fighting the per-frame opacity writes.
        focal_ring = None
        focal_teardown = None
        if sat is not None:
            focal_ring = getattr(sat, "_focal_ring", None)
            focal_teardown = getattr(sat, "_focal_ring_cleanup", None)
            if focal_teardown is not None:
                focal_teardown()
            sat._focal_ring = None
            sat._focal_ring_cleanup = None

        def cleanup():
            self._kill_pulse(pulse)
            if focal_ring is not None:
                if focal_ring in self.scene.mobjects:
                    self.scene.remove(focal_ring)
                self._deregister_ephemeron(focal_ring)

        anims = [pulse.animate.move_to(dst.center())]
        if sat is not None:
            anims.append(sat.animate.move_to(dst.center()))
        if focal_ring is not None:
            anims.append(FadeOut(focal_ring, run_time=self.block_seconds * 0.6))
        return AnimationGroup(*anims, lag_ratio=0.1), cleanup

    def _ev_settle(self, ev):
        sat = self.satellites.get(ev["step_id"])
        contract = self.actors[ev["actor"]]
        if sat is None:
            return contract.wobble()
        status = ev.get("status", "ok")
        sat.set_color_for_status(status)
        # If this is the last satellite on this contract, fade the
        # orbit guide in the same beat.
        guide_fade = self._orbit_guide_fade_on_release(ev["actor"])
        # Focal ring retirement — in case the settle fires without a
        # preceding downstream_return (e.g. synthetic scenes where the
        # two events share a block and the return handler already
        # cleared it, or timeout paths). Safety-clean here too.
        focal_ring = getattr(sat, "_focal_ring", None)
        focal_teardown = getattr(sat, "_focal_ring_cleanup", None)
        if focal_teardown is not None:
            focal_teardown()
        sat._focal_ring = None
        sat._focal_ring_cleanup = None

        focal_ring_ref = focal_ring
        # `no_buy` is a visitor who dwelled and declined. No bloom,
        # no wobble — the shop didn't change state. Satellite fades
        # pale. Pet stays available for subsequent visitors.
        anims = [
            sat.animate.scale(0.3).set_opacity(0.0),
        ]
        if status != "no_buy":
            anims.insert(0, contract.wobble())
        if guide_fade is not None:
            anims.append(guide_fade)

        # Bloom on ok — a soft green expanding ring at the satellite's
        # last position. Purely ambient; no semantic change. Failing
        # statuses (err/timeout) skip the green bloom. `no_buy` also
        # skips (quiet settle).
        bloom_mob = None
        shock_mob = None
        if status == "ok":
            bloom_mob, bloom_anim = settle_ok_bloom(sat.get_center())
            self.scene.add(bloom_mob)
            self._register_ephemeron(bloom_mob)
            anims.append(bloom_anim)
            # Wider, softer secondary shockwave — overlays the primary
            # bloom and outlasts it by ~0.4s, giving weight to the
            # successful exit.
            shock_mob, shock_anim = settle_shockwave(sat.get_center())
            self.scene.add(shock_mob)
            self._register_ephemeron(shock_mob)
            anims.append(shock_anim)

        anim = AnimationGroup(*anims, lag_ratio=0.2)

        def cleanup():
            if sat.budget_ring is not None:
                self.scene.remove(sat.budget_ring)
            for dot in sat.trail_dots:
                if dot in self.scene.mobjects:
                    self.scene.remove(dot)
            self.scene.remove(sat)
            for m in (bloom_mob, shock_mob):
                if m is not None:
                    if m in self.scene.mobjects:
                        self.scene.remove(m)
                    self._deregister_ephemeron(m)
            if focal_ring_ref is not None:
                if focal_ring_ref in self.scene.mobjects:
                    self.scene.remove(focal_ring_ref)
                self._deregister_ephemeron(focal_ring_ref)
            self.satellites.pop(ev["step_id"], None)
            self._ejection_blocks.pop(ev["step_id"], None)
            self._release_orbit_guide(ev["actor"])

        return anim, cleanup

    # ------------------------------------------------------------------
    # Budget numeral — visible NEP-519 countdown
    # ------------------------------------------------------------------

    def _ev_budget_numeral(self, ev):
        """Large amber countdown anchored near a specific satellite.
        Makes the 200-block yield budget tactile: the viewer watches
        a running number (198 → 97 → 20 → 0 blocks) rather than just
        an abstract shrinking ring.

        Fields:
            step_id    — which satellite to track (required)
            offset     — [dx, dy] from satellite body (default [1.2, 0.7])
            font_size  — default 40

        The numeral updates via a per-frame updater that reads the
        satellite's ejection block and the scene's current block.
        Remove it via a matching `budget_numeral_hide` event targeting
        the same step_id (typically one block after timeout/settle,
        so the terminal '0' still flashes before dismissal).

        Urgency threshold: below 20 remaining blocks, the numeral and
        the satellite body both tint red in the same beat, so the
        "time is almost up" signal reads across channels.

        Registered as an ephemeron; if the author forgets the hide
        event, the ephemera-leak check at scene end names the leaker.
        """
        step_id = ev.get("step_id")
        if not step_id:
            return None
        sat = self.satellites.get(step_id)
        if sat is None:
            return None
        ejected = self._ejection_blocks.get(step_id)
        if ejected is None:
            return None

        font_size = int(ev.get("font_size", 40))
        offset = ev.get("offset") or [1.2, 0.7]
        dx, dy = float(offset[0]), float(offset[1])

        # Two-piece group: the big number + small "blocks" label.
        # Amber matches the budget ring so the viewer ties the number
        # visually to the arc shrinking on the satellite.
        numeral = Text(
            f"{self._yield_budget_blocks}",
            font=DEFAULT_FONT, font_size=font_size, color=SATELLITE_AMBER,
        )
        unit = Text(
            "blocks",
            font=DEFAULT_FONT, font_size=int(font_size * 0.45),
            color=SATELLITE_AMBER,
        )
        group = VGroup(numeral, unit)
        unit.next_to(numeral, RIGHT, buff=0.12, aligned_edge=DOWN)
        sat_center = np.array(
            sat.body.get_center() if hasattr(sat, "body") else sat.get_center(),
            dtype=float,
        )
        group.move_to(sat_center + np.array([dx, dy, 0.0]))
        self._register_ephemeron(group)
        self.scene.add(group)

        # Track which numeral belongs to which step_id so the matching
        # hide event can find + remove it.
        self._budget_numerals = getattr(self, "_budget_numerals", {})
        self._budget_numerals[step_id] = group

        last_value_box = {"v": self._yield_budget_blocks}

        # Param name `dt` is load-bearing: Manim's Mobject.update
        # inspects `"dt" in inspect.signature(updater).parameters` to
        # decide whether to call updater(self, dt) or updater(self).
        # We don't use dt — the scene's block clock (self._current_block)
        # advances per _tick_blocks, not per frame — but the parameter
        # must exist and be named dt for the signature check to match.
        def updater(_mob, dt):
            elapsed = self._current_block - ejected
            remaining = max(0, self._yield_budget_blocks - elapsed)
            # Only rebuild the Text mobject when the displayed integer
            # actually changes — rebuilding a Text SVG every frame is
            # expensive and unnecessary.
            if remaining != last_value_box["v"]:
                last_value_box["v"] = remaining
                # Urgency recolour: below threshold the numeral and
                # its unit label go red; the satellite body follows
                # via set_urgency so body + numeral tell one coherent
                # story instead of two competing channels.
                urgent = remaining < 20
                colour = FAILURE_RED if urgent else SATELLITE_AMBER
                new_numeral = Text(
                    f"{remaining}",
                    font=DEFAULT_FONT, font_size=font_size, color=colour,
                )
                new_numeral.move_to(numeral.get_center())
                numeral.become(new_numeral)
                unit.set_color(colour)
                unit.next_to(numeral, RIGHT, buff=0.12, aligned_edge=DOWN)
                if hasattr(sat, "set_urgency"):
                    sat.set_urgency(urgent)
            # Follow the satellite even if it orbits — the numeral is
            # conceptually attached to the satellite's body.
            current_center = np.array(
                sat.body.get_center() if hasattr(sat, "body") else sat.get_center(),
                dtype=float,
            )
            group.move_to(current_center + np.array([dx, dy, 0.0]))

        group.add_updater(updater)
        return FadeIn(group, run_time=0.45)

    def _ev_budget_numeral_hide(self, ev):
        """Remove a budget_numeral previously spawned for this step_id.
        Detaches the updater, fades out, deregisters the ephemeron.
        Typically fires one block after timeout/settle so the terminal
        value flashes before the card dismisses.
        """
        step_id = ev.get("step_id")
        numerals = getattr(self, "_budget_numerals", None) or {}
        group = numerals.get(step_id)
        if group is None:
            return None
        group.clear_updaters()
        fade_out = FadeOut(group, run_time=0.45)

        def cleanup():
            if group in self.scene.mobjects:
                self.scene.remove(group)
            self._deregister_ephemeron(group)
            numerals.pop(step_id, None)

        return fade_out, cleanup

    # ------------------------------------------------------------------
    # Authoring events — reveal + narrative
    # ------------------------------------------------------------------
    # These event types don't map to NEAR contract primitives.
    # They're authoring-level: the narrator using manim idioms to
    # direct attention (progressive reveal of a character, a thesis
    # card). Every other event type tracks 1:1 with a contract primitive
    # — these are the documented exception.

    def _ev_actor_appear(self, ev):
        """Fade an actor into the scene mid-timeline. The actor must
        have been placed with `visible_at_start: false` so its mobject
        is in `self.actors` but not yet `scene.add`ed. `FadeIn` adds
        the mobject when it plays.
        """
        actor_id = ev["actor"]
        mob = self.actors.get(actor_id)
        if mob is None:
            return None
        self._deferred_actors.discard(actor_id)
        return FadeIn(mob, run_time=max(0.45 * self.pacing, 0.1))

    def _ev_narrative(self, ev):
        """Fire an author-authored teach card. Reuses the slot /
        eviction / keep-alive machinery of `_maybe_callout` but bypasses
        the event-type lookup and first-appearance dedup — every
        narrative card is unique and author-placed. Styled with the
        `narrative` kind for a visual tell.

        Like `_maybe_callout`, doesn't return a FadeIn — `_play_batch`
        builds those after dispatch. Returns None for the dispatch
        path.
        """
        if not self._callouts_enabled:
            return None
        title = ev.get("title", "")
        body = ev.get("body", "")
        if not title and not body:
            return None
        card = build_teach_card(title, body, kind="narrative")
        pending = getattr(self, "_callouts_pending", [])

        occupied_slots = {item[3] for item in pending}
        free_slot = next(
            (i for i in range(self._TEACH_MAX_SLOTS) if i not in occupied_slots),
            None,
        )
        if free_slot is None:
            # Narrative can evict anything — vocab or another
            # narrative. Author-placed thesis cards supersede earlier
            # author-placed thesis cards (the story evolved).
            oldest = pending.pop(0)
            oldest_mob = oldest[0]
            free_slot = oldest[3]
            if oldest_mob in self.scene.mobjects:
                self.scene.remove(oldest_mob)

        y = self._TEACH_TOP_Y - free_slot * self._TEACH_ROW_SPACING
        card.move_to(np.array([0.0, y, 0.0]))
        pending.append((
            card,
            {"keep_alive_blocks": self._TEACH_KEEP_ALIVE_BLOCKS,
             "is_narrative": True,
             "needs_fadein": True},
            self._current_block,
            free_slot,
        ))
        self._callouts_pending = pending
        return None

