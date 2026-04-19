"""The orbiting-satellite primitive.

A `Satellite` is a small labelled disk that orbits a `LiquidContract`.
The orbit is driven by an updater that reads two `ValueTracker`s:

- `radius_tracker`  — orbit radius; interpolating toward 0 models decay
- `omega_tracker`   — angular velocity; 0 freezes the satellite in place

During a retrieval cascade the satellite is detached from orbit,
travelled to a target contract (downstream_call), and either faded out
green (ok settle), red (err settle), or red-flashed inward (decay).
"""

from __future__ import annotations

import numpy as np
from manim import (
    VGroup,
    Circle,
    Dot,
    ValueTracker,
    Arc,
    always_redraw,
    PI,
    TAU,
)

from .palette import (
    SATELLITE_AMBER,
    SATELLITE_AMBER_GLOW,
    SATELLITE_EDGE,
    FAILURE_RED,
    TEXT_DARK,
)
from .typography import kerned_text


_TRAIL_OPACITIES = (0.60, 0.50, 0.41, 0.33, 0.26, 0.20, 0.15, 0.10, 0.06, 0.03)
# Total trail duration = len(_TRAIL_OPACITIES) * _TRAIL_SAMPLE_S ≈ 0.50s.
# Shorter sample interval (0.05s) + more samples gives a dense, curve-
# like trail rather than discrete steps, at negligible per-frame cost.
_TRAIL_SAMPLE_S = 0.05


def _hex_to_rgb(h: str) -> tuple[float, float, float]:
    h = h.lstrip("#")
    return (int(h[0:2], 16) / 255.0, int(h[2:4], 16) / 255.0, int(h[4:6], 16) / 255.0)


def _rgb_to_hex(r: float, g: float, b: float) -> str:
    return "#{:02x}{:02x}{:02x}".format(
        max(0, min(255, int(round(r * 255)))),
        max(0, min(255, int(round(g * 255)))),
        max(0, min(255, int(round(b * 255)))),
    )


def _lerp_hex(a_hex: str, b_hex: str, t: float) -> str:
    """Linear RGB interpolation — avoids manim's interpolate_color gotcha
    (which expects ManimColor, not raw hex strings). t=0 → a, t=1 → b.
    """
    t = max(0.0, min(1.0, t))
    ar, ag, ab = _hex_to_rgb(a_hex)
    br, bg, bb = _hex_to_rgb(b_hex)
    return _rgb_to_hex(
        ar + (br - ar) * t,
        ag + (bg - ag) * t,
        ab + (bb - ab) * t,
    )


class SatelliteLabelOverflow(AssertionError):
    """Raised when a satellite label doesn't fit inside its body."""


class Satellite(VGroup):
    def __init__(
        self,
        label: str,
        radius: float = 0.32,
        fill_color: str = SATELLITE_AMBER,
        stroke_color: str = SATELLITE_EDGE,
        text_color: str = TEXT_DARK,
        font_size: int = 11,
        **kwargs,
    ):
        super().__init__(**kwargs)
        self.label = label
        self.body = Circle(
            radius=radius,
            color=stroke_color,
            fill_color=fill_color,
            fill_opacity=0.95,
            stroke_width=1.5,
        )
        # Inner glow — lighter amber core offset toward the top-left
        # light source, same convention as the contracts. Reads as a
        # lit 3D bead rather than a flat disc.
        glow_color = SATELLITE_AMBER_GLOW if fill_color == SATELLITE_AMBER else fill_color
        self.body_glow = Circle(
            radius=radius * 0.46,
            color=glow_color, fill_color=glow_color,
            fill_opacity=0.55, stroke_width=0,
        )
        self.body_glow.shift(np.array([-radius * 0.20, radius * 0.20, 0.0]))
        # Satellite tag sits inside a tight disk — no loosening or it
        # overflows the fatal body-fit assertion below.
        self.tag = kerned_text(label, font_size=font_size, color=text_color, letter_spacing=0)
        # Move the label then assert it fits — fatal by design so a
        # surprise long label doesn't silently get clipped by the
        # body circle (VISUAL_QA.md §1).
        self.tag.move_to(self.body.get_center())
        max_width = 2.0 * radius * 0.92
        max_height = 2.0 * radius * 0.9
        if self.tag.width > max_width or self.tag.height > max_height:
            raise SatelliteLabelOverflow(
                f"satellite label {label!r} is "
                f"{self.tag.width:.2f}×{self.tag.height:.2f} "
                f"but body fits {max_width:.2f}×{max_height:.2f}. "
                f"Shrink font_size or increase radius."
            )

        self.add(self.body, self.body_glow, self.tag)

        # Trail dots — live outside the VGroup so orbit/attach move_to
        # doesn't drag them. Caller (TimelinePlayer) adds them to the
        # scene and removes them at settle/decay cleanup. `trail_dots`
        # is the public handle.
        self.trail_dots = [
            Dot(radius=radius * 0.42, color=fill_color, fill_opacity=0.0)
            for _ in _TRAIL_OPACITIES
        ]
        self._trail_history: list[np.ndarray] = []
        self._trail_accum = 0.0
        self._install_trail_updater()

        # Orbit state — populated by `attach_orbit`.
        self._parent = None
        self._theta = 0.0
        self.radius_tracker: ValueTracker | None = None
        self.omega_tracker: ValueTracker | None = None
        self._orbit_updater = None

        # Yield budget ring. Sweeps 360° → 0° as blocks elapse. Drawn
        # via always_redraw so it follows the satellite around its
        # orbit and re-colours as the budget drops.
        self._body_radius = radius
        self.budget_tracker = ValueTracker(1.0)
        self.budget_ring = None  # set when attached to scene

        # Urgency state — flipped by `set_urgency` when the yield
        # budget is about to expire. The `budget_numeral` event's
        # updater drives this from TimelinePlayer so body + numeral
        # respond to a single threshold, giving the viewer one
        # coherent "time is almost up" signal across channels. Lazy
        # init: stays False until first set_urgency call.
        self._is_urgent = False

    def set_urgency(self, urgent: bool):
        """Tint the body amber → red (or back) based on budget state.

        The core body reads as "this callback is about to time out"
        when ``urgent=True``. Called from the `budget_numeral` event's
        updater when remaining blocks cross a threshold (currently
        <20). Idempotent and cheap — skips re-rendering when state is
        already at the target.

        Keeping the body_glow in a matching red-tinted version
        preserves the lit 3D bead look. The body stroke edge stays at
        SATELLITE_EDGE for silhouette consistency.
        """
        if self._is_urgent == urgent:
            return
        self._is_urgent = urgent
        if urgent:
            self.body.set_fill(color=FAILURE_RED)
            # Lighter red for the glow, mirroring how
            # SATELLITE_AMBER_GLOW is brighter than SATELLITE_AMBER.
            self.body_glow.set_fill(
                color=_lerp_hex(FAILURE_RED, "#ffffff", 0.35),
            )
        else:
            self.body.set_fill(color=SATELLITE_AMBER)
            self.body_glow.set_fill(color=SATELLITE_AMBER_GLOW)

    # ------------------------------------------------------------------
    # Orbit mechanics
    # ------------------------------------------------------------------

    def attach_orbit(
        self,
        parent,
        initial_radius: float,
        angular_speed: float,
        initial_angle: float = 0.0,
    ):
        """Bind this satellite to orbit `parent` at `initial_radius`.

        Subsequent animations can drive `radius_tracker` / `omega_tracker`
        to change orbit geometry smoothly.
        """
        self._parent = parent
        self._theta = initial_angle
        self.radius_tracker = ValueTracker(initial_radius)
        self.omega_tracker = ValueTracker(angular_speed)
        # Per-satellite wobble parameters — different phases keep
        # neighbouring satellites from breathing in lock-step.
        self._wobble_t = 0.0
        self._wobble_phase = float((hash(self.label) % 628) / 100.0)  # 0..2π-ish

        # Place immediately so it renders correctly on the first frame.
        self._place_now()

        def _updater(m: "Satellite", dt: float):
            if m.omega_tracker is None or m.radius_tracker is None or m._parent is None:
                return
            m._theta += m.omega_tracker.get_value() * dt
            m._wobble_t += dt
            # Radial wobble: ±1.5% around the tracker value, 5s period.
            # Small enough that neither overlap nor orbit-guide
            # alignment is disturbed; large enough that the eye reads
            # "orbit is alive" instead of "fixed circle".
            wobble = 1.0 + 0.015 * np.sin(
                m._wobble_t * (2.0 * PI / 5.0) + m._wobble_phase
            )
            r = m.radius_tracker.get_value() * wobble
            c = m._parent.center()
            m.move_to(c + r * np.array([np.cos(m._theta), np.sin(m._theta), 0.0]))

        self._orbit_updater = _updater
        self.add_updater(_updater)

    def detach_orbit(self):
        """Stop following the orbit updater. Position is left where it is."""
        if self._orbit_updater is not None:
            self.remove_updater(self._orbit_updater)
            self._orbit_updater = None

    def start_yield_decay(self, duration_seconds: float, target_radius: float = 0.0):
        """Begin a continuous decay: orbit radius drifts from current
        value toward `target_radius` over `duration_seconds` of wall time.

        The updater is attached to `self` (the satellite) rather than
        to `self.radius_tracker` because the satellite is in the scene
        graph — only its updaters run during `scene.wait()`. A
        ValueTracker that isn't explicitly added to the scene never
        gets its updaters fired, which caused a silent no-op decay
        before this was moved.
        """
        if self.radius_tracker is None:
            return
        start_r = self.radius_tracker.get_value()
        delta_per_s = (start_r - target_radius) / max(duration_seconds, 1e-6)

        def shrinker(_mob, dt):
            current = self.radius_tracker.get_value()
            new_r = max(target_radius, current - delta_per_s * dt)
            self.radius_tracker.set_value(new_r)

        self.add_updater(shrinker)

    def _place_now(self):
        if self._parent is None or self.radius_tracker is None:
            return
        c = self._parent.center()
        r = self.radius_tracker.get_value()
        self.move_to(c + r * np.array([np.cos(self._theta), np.sin(self._theta), 0.0]))

    # ------------------------------------------------------------------
    # Visual helpers
    # ------------------------------------------------------------------

    def set_color_for_status(self, status: str):
        """Recolour for terminal status — returns the satellite for chaining."""
        from .palette import SUCCESS_GREEN, FAILURE_RED

        if status == "ok":
            self.body.set_fill(SUCCESS_GREEN, opacity=0.95)
        elif status in ("err", "timeout"):
            self.body.set_fill(FAILURE_RED, opacity=0.95)
        elif status == "no_buy":
            # Visit happened, visitor declined. Dim the amber fill so
            # the drain reads as "no commitment made" — distinct from
            # ok (green) and err/timeout (red).
            self.body.set_fill(SATELLITE_AMBER, opacity=0.55)
        return self

    # ------------------------------------------------------------------
    # Yield budget ring
    # ------------------------------------------------------------------

    def make_budget_ring(self):
        """Return a mobject ring that redraws each frame to reflect
        remaining yield budget. Caller adds it to the scene separately
        from the satellite's VGroup (always_redraw returns a new
        mobject per frame, so it can't be a VGroup child).
        """
        ring_radius = self._body_radius * 1.55

        def _redraw():
            frac = max(0.0, min(1.0, self.budget_tracker.get_value()))
            if frac <= 0.01:
                # Avoid zero-angle Arc; return an invisible placeholder.
                arc = Arc(
                    radius=ring_radius,
                    start_angle=0.0,
                    angle=0.001,
                    stroke_width=0.0,
                )
            else:
                # Smooth amber → red gradient as budget burns.
                # frac > 0.5: stay full amber.
                # frac ≤ 0.5: lerp amber→red by (1 - 2*frac), so at
                # frac=0 it's full red, at frac=0.5 it's pure amber.
                if frac > 0.5:
                    color = SATELLITE_EDGE
                else:
                    t = 1.0 - (frac / 0.5)
                    color = _lerp_hex(SATELLITE_EDGE, FAILURE_RED, t)
                arc = Arc(
                    radius=ring_radius,
                    start_angle=PI / 2.0,   # start at 12 o'clock
                    angle=-TAU * frac,      # clockwise shrink
                    color=color,
                    stroke_width=2.6,
                )
            arc.move_arc_center_to(self.body.get_center())
            return arc

        self.budget_ring = always_redraw(_redraw)
        return self.budget_ring

    # ------------------------------------------------------------------
    # Trail
    # ------------------------------------------------------------------

    def _install_trail_updater(self):
        """Sample body position every ~0.10s into a short ring buffer,
        and redraw the trail dots at those buffered positions with
        decaying opacity. Colour tracks the body so post-settle recolor
        (green/red) flows into the trail briefly before the satellite
        is removed. Trail dots live in absolute world coordinates —
        they are NOT children of the VGroup, so orbit `move_to` on
        the satellite does not drag them.
        """
        max_n = len(self.trail_dots)

        def _update(_mob, dt):
            self._trail_accum += dt
            while self._trail_accum >= _TRAIL_SAMPLE_S:
                self._trail_accum -= _TRAIL_SAMPLE_S
                self._trail_history.insert(0, np.array(self.body.get_center()))
                if len(self._trail_history) > max_n:
                    self._trail_history.pop()
            body_color = self.body.get_fill_color()
            for i, dot in enumerate(self.trail_dots):
                if i < len(self._trail_history):
                    dot.move_to(self._trail_history[i])
                    dot.set_fill(color=body_color, opacity=_TRAIL_OPACITIES[i])
                    dot.set_stroke(width=0)
                else:
                    dot.set_fill(opacity=0.0)

        self.add_updater(_update)
