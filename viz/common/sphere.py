"""The liquid-sphere contract primitive.

A `LiquidContract` is a semi-transparent circle that wobbles when a
receipt lands on it. Identity is split into two labels so the sphere
never has text overflowing its boundary:

- `display_name`  — short label rendered *inside* the sphere (e.g. "smart-account")
- `account_id`    — full ID rendered as a smaller caption *below* the sphere
                    (e.g. "smart-account.x.mike.testnet")

A load-time assertion guarantees `display_name` fits inside the body
radius at the configured font size; if it doesn't, the render aborts
with a clear message (see VISUAL_QA.md rule 1).
"""

from __future__ import annotations

import numpy as np
from manim import VGroup, Circle, there_and_back, DOWN, TAU

from .palette import (
    CONTRACT_TEAL,
    CONTRACT_STROKE,
    CONTRACT_TEAL_GLOW,
    PERSON_ORANGE,
    PERSON_ORANGE_GLOW,
    PERSON_EDGE,
    SUCCESS_GREEN,
    TEXT_DARK,
    TEXT_LIGHT,
    SPECULAR_LIGHT,
)
from .typography import kerned_text


class LabelOverflowError(AssertionError):
    """Raised when a label is wider than the container it lives inside."""


class LiquidContract(VGroup):
    """A contract rendered as a translucent, wobble-responsive sphere."""

    def __init__(
        self,
        display_name: str,
        account_id: str | None = None,
        radius: float = 1.1,
        fill_color: str = CONTRACT_TEAL,
        stroke_color: str = CONTRACT_STROKE,
        text_color: str = TEXT_LIGHT,
        display_font_size: int = 18,
        caption_font_size: int = 14,
        caption_color: str = TEXT_LIGHT,
        **kwargs,
    ):
        super().__init__(**kwargs)
        self._radius = radius
        self.display_name = display_name
        self.account_id = account_id or display_name

        # Outer glow halo — three concentric layers build a soft
        # falloff rather than a single hard ring. Opacities chosen so
        # the cumulative alpha at every radius is close to a true
        # radial gradient and never exceeds the previous single-ring
        # halo's visual weight. Ambient only; does not participate in
        # overlap checks (body_bbox() uses _radius).
        self.halo = VGroup()
        halo_far = Circle(
            radius=radius * 1.22, color=fill_color, fill_color=fill_color,
            fill_opacity=0.04, stroke_width=0,
        )
        halo_mid = Circle(
            radius=radius * 1.14, color=fill_color, fill_color=fill_color,
            fill_opacity=0.07, stroke_width=0,
        )
        halo_near = Circle(
            radius=radius * 1.07, color=fill_color, fill_color=fill_color,
            fill_opacity=0.10, stroke_width=0,
        )
        self.halo.add(halo_far, halo_mid, halo_near)

        # Body (authoritative). Its `.width` drives layout, overlap,
        # and wobble. Fill / opacity kept at their long-established
        # values so label contrast and overall readability don't
        # regress — the new material layers sit *above* it.
        self.body = Circle(
            radius=radius,
            color=stroke_color,
            fill_color=fill_color,
            fill_opacity=0.55,
            stroke_width=2.2,
        )
        # Inner glow — lighter teal offset toward the top-left light
        # source. Subtle: 32% opacity and ~55% of the body radius so
        # it reads as shading, not a second disc. No darker outer
        # layer — the existing stroke + cosmic background provide
        # rim contrast.
        self.body_glow = Circle(
            radius=radius * 0.55,
            color=CONTRACT_TEAL_GLOW, fill_color=CONTRACT_TEAL_GLOW,
            fill_opacity=0.32, stroke_width=0,
        )
        self.body_glow.shift(np.array([-radius * 0.22, radius * 0.22, 0.0]))
        # Specular highlight — soft gloss implying top-left light.
        # Two layers for a gradient falloff: a brighter core nested
        # inside a softer halo. Both sit fully inside the body (max
        # reach 0.66r < 1.0r), so they never leak past the stroke.
        self.highlight = VGroup()
        hl_soft = Circle(
            radius=radius * 0.32,
            color=SPECULAR_LIGHT,
            fill_color=SPECULAR_LIGHT,
            fill_opacity=0.18,
            stroke_width=0,
        )
        hl_core = Circle(
            radius=radius * 0.14,
            color=SPECULAR_LIGHT,
            fill_color=SPECULAR_LIGHT,
            fill_opacity=0.55,
            stroke_width=0,
        )
        hl_soft.shift(np.array([-radius * 0.38, radius * 0.38, 0.0]))
        hl_core.shift(np.array([-radius * 0.40, radius * 0.40, 0.0]))
        self.highlight.add(hl_soft, hl_core)

        # State residue — a full-radius green overlay that stays at
        # opacity 0 until a state-touching event calls `reveal_state_residue`.
        # Pedagogically: the thesis is "did it happen?" and the visible
        # answer is a persistent mark that stays on the sphere for every
        # later frame. Positioned above body_glow and below highlight so
        # the specular gloss stays white (light source didn't change)
        # and text stays crisp (sits above residue).
        #
        # Radius at 0.97r keeps the tint just inside the stroke so it
        # reads as "inside the sphere" rather than painting over the
        # outline. See `reveal_state_residue` below for the fire-once
        # behaviour (subsequent touches don't dim a previously-lit tint).
        self.state_residue = Circle(
            radius=radius * 0.97,
            color=SUCCESS_GREEN,
            fill_color=SUCCESS_GREEN,
            fill_opacity=0.0,
            stroke_width=0,
        )

        self.name_label = kerned_text(display_name, font_size=display_font_size, color=text_color)
        self.name_label.move_to(self.body.get_center())

        # Invariant: display_name fits inside the sphere (rule 1).
        max_width = 2.0 * radius * 0.92  # 8% margin inside the stroke
        if self.name_label.width > max_width:
            raise LabelOverflowError(
                f"display_name {display_name!r} is {self.name_label.width:.2f} wide "
                f"but sphere diameter is {2 * radius:.2f} (limit {max_width:.2f}). "
                f"Use a shorter display_name or decrease display_font_size."
            )

        self.caption = kerned_text(
            self.account_id,
            font_size=caption_font_size,
            color=caption_color,
        )
        # Default placement is just below the body. Scenes with
        # satellites orbiting this contract call `place_caption_below`
        # to push the caption outside the orbital zone (VISUAL_QA.md
        # task #30 — silent overlap between south-phase satellites
        # and account_id caption).
        self.caption.next_to(self.body, DOWN, buff=0.14)

        # Z-order: halo (back) → body → body_glow → state_residue →
        # highlight → label → caption. state_residue sits above the
        # shading layers but below the specular highlight so when
        # revealed the sphere reads green-tinted while the highlight
        # stays white (light source didn't change — state changed).
        # Label + caption sit above everything so readability is never
        # at the mercy of a gradient stop.
        self.add(
            self.halo,
            self.body, self.body_glow, self.state_residue,
            self.highlight, self.name_label, self.caption,
        )

        # Breathe: subtle ±3% scale pulse on the halo group, ~4s period.
        # Scaling the VGroup uniformly keeps the three concentric
        # halos aligned; tracking the previous scale avoids drift.
        self._breathe_phase = 0.0
        self._halo_scale = 1.0
        halo_center = self.body.get_center()

        def _breathe(group, dt):
            self._breathe_phase += dt
            target = 1.0 + 0.03 * np.sin(self._breathe_phase * (TAU / 4.0))
            delta = target / self._halo_scale
            if abs(delta - 1.0) < 1e-4:
                return
            group.scale(delta, about_point=halo_center)
            self._halo_scale = target

        self.halo.add_updater(_breathe)

    def place_caption_below(self, distance: float, buff: float = 0.18):
        """Move the caption to body_center + [0, -distance - buff, 0].

        Used by TimelinePlayer.place_actors to push the caption just
        outside the orbital zone so satellites at any phase don't
        intersect it.
        """
        c = self.body.get_center()
        # caption.next_to is simpler and gets the vertical alignment
        # right automatically — easier than manual move_to with
        # height-half offsets.
        self.caption.next_to(c + np.array([0.0, -distance, 0.0]), DOWN, buff=buff)

    @property
    def body_radius(self) -> float:
        return self._radius

    def center(self):
        return self.body.get_center()

    def body_bbox(self):
        """Return (x_min, x_max, y_min, y_max) of the sphere body only."""
        c = self.body.get_center()
        r = self._radius
        return (c[0] - r, c[0] + r, c[1] - r, c[1] + r)

    def reveal_state_residue(self, target_opacity: float = 0.22, run_time: float = 0.6):
        """Fade the green state-residue overlay up to `target_opacity`.

        Monotonic: if the residue is already brighter than target the
        animation is a no-op (still returned so the caller can compose
        it into an AnimationGroup without a None-guard). Pedagogically:
        a contract's state having changed is a one-way door; the tint
        persists for the rest of the scene, marking the sphere as
        "this holds state that wasn't here before."

        Call sites: every event that corresponds to a contract primitive
        that mutates target state — currently `detached_land` (Flow B's
        detached sink.append) and `inner_dispatch` (Flow C's adapter
        courier reaching sink). Not fired from `downstream_return`
        because not every downstream call is a state-mutation (unit.run_unit
        is a no-op); we're strict here so the tint stays a meaningful
        thesis signal rather than ambient decoration.
        """
        current = self.state_residue.get_fill_opacity()
        new_opacity = max(current, target_opacity)
        if new_opacity <= current + 1e-4:
            # Monotonic no-op — return a zero-duration animation so the
            # caller's AnimationGroup composition doesn't need a branch.
            return self.state_residue.animate.set_fill(opacity=current)
        return self.state_residue.animate.set_fill(opacity=new_opacity)

    def wobble(self, peak: float = 1.10, run_time: float = 0.45):
        """Brief scale pulse on body + highlight — label stays anchored.

        Scaling the body and highlight together (anchored at the body
        centre) keeps the specular gloss visually attached during the
        wobble. The halo is intentionally excluded so its breathe
        updater doesn't fight the wobble animation.
        """
        anchor = self.body.get_center()
        # Shading layers must wobble with the body so the implied
        # light direction stays attached to the surface.
        group = VGroup(self.body, self.body_glow, self.highlight)
        return group.animate(rate_func=there_and_back, run_time=run_time).scale(
            peak, about_point=anchor
        )


class PersonActor(VGroup):
    """A caller / runner — rendered as a small labelled orange disk."""

    def __init__(
        self,
        label: str,
        radius: float = 0.38,
        fill_color: str = PERSON_ORANGE,
        stroke_color: str = PERSON_EDGE,
        text_color: str = TEXT_DARK,
        font_size: int = 16,
        **kwargs,
    ):
        super().__init__(**kwargs)
        self._radius = radius
        self.body = Circle(
            radius=radius,
            color=stroke_color,
            fill_color=fill_color,
            fill_opacity=0.95,
            stroke_width=2,
        )
        # Inner glow — same top-left light direction as the spheres,
        # at a smaller scale proportional to the person's radius.
        self.body_glow = Circle(
            radius=radius * 0.48,
            color=PERSON_ORANGE_GLOW, fill_color=PERSON_ORANGE_GLOW,
            fill_opacity=0.55, stroke_width=0,
        )
        self.body_glow.shift(np.array([-radius * 0.18, radius * 0.18, 0.0]))
        self.name_label = kerned_text(label, font_size=font_size, color=text_color)
        self.name_label.next_to(self.body, DOWN, buff=0.12)
        self.add(self.body, self.body_glow, self.name_label)

    def center(self):
        return self.body.get_center()

    def body_bbox(self):
        c = self.body.get_center()
        r = self._radius
        return (c[0] - r, c[0] + r, c[1] - r, c[1] + r)
