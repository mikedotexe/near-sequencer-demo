"""Settle / decay blooms — terminal-status accents.

A `settle_ok` event used to just fade the satellite out; this module
adds a soft green expanding ring that tells the eye "done, clean
exit". A `decay` used to fade-to-red inward; this module adds a small
red ember-burst that evokes disintegration. Both are ambient — they
reinforce meaning rather than carry it — so existing assertions and
scene timing are unaffected.
"""

from __future__ import annotations

import numpy as np
from manim import ArcBetweenPoints, Circle, Dot, VGroup, FadeOut, AnimationGroup

from .palette import SUCCESS_GREEN, FAILURE_RED, SATELLITE_AMBER


def settle_ok_bloom(center, radius: float = 0.60, run_time: float = 0.55):
    """Return (mobject, animation). The mobject should be added to the
    scene before play(); the caller is responsible for removing it in
    the post-batch cleanup (or registering with ephemera hygiene).

    The ring expands from 0 -> `radius` while fading 0.85 -> 0, evoking
    a soft dock-pulse at the parent contract.
    """
    ring = Circle(
        radius=0.05,
        color=SUCCESS_GREEN,
        stroke_width=2.8,
        stroke_opacity=0.85,
        fill_opacity=0.0,
    )
    ring.move_to(center)
    # scale to final_radius / start_radius = radius / 0.05
    scale_factor = radius / 0.05
    anim = AnimationGroup(
        ring.animate.scale(scale_factor).set_stroke(opacity=0.0),
        run_time=run_time,
    )
    return ring, anim


def eject_ring(center, start_radius: float, end_radius: float, run_time: float = 0.45):
    """Return (mobject, animation). A thin amber ring that expands
    from the parent sphere's surface outward to the orbit radius,
    fading as it goes. Punctuates yield_eject with a "launch pulse"
    visible before the satellite finishes its radial travel.
    """
    ring = Circle(
        radius=max(start_radius, 0.05),
        color=SATELLITE_AMBER,
        stroke_width=3.2,
        stroke_opacity=0.88,
        fill_opacity=0.0,
    )
    ring.move_to(center)
    scale_factor = end_radius / max(start_radius, 0.05)
    anim = AnimationGroup(
        ring.animate.scale(scale_factor).set_stroke(opacity=0.0),
        run_time=run_time,
    )
    return ring, anim


def settle_shockwave(center, radius: float = 1.15, run_time: float = 0.95):
    """Secondary, wider, slower shockwave layered behind the primary
    settle_ok_bloom. Low opacity and long run_time — reads as a
    settling wave expanding into the frame rather than a second ping.
    Implies mass absorbed by the contract that just settled.
    """
    ring = Circle(
        radius=0.05,
        color=SUCCESS_GREEN,
        stroke_width=1.8,
        stroke_opacity=0.42,
        fill_opacity=0.0,
    )
    ring.move_to(center)
    scale_factor = radius / 0.05
    anim = AnimationGroup(
        ring.animate.scale(scale_factor).set_stroke(opacity=0.0),
        run_time=run_time,
    )
    return ring, anim


def decay_shockwave(center, radius: float = 1.00, run_time: float = 1.10):
    """Red counterpart to `settle_shockwave`. Slightly smaller and
    slower — pairs with `decay_ember` so the fade-out reads as a
    heavy, mournful loss rather than a brief red flash.
    """
    ring = Circle(
        radius=0.05,
        color=FAILURE_RED,
        stroke_width=1.6,
        stroke_opacity=0.48,
        fill_opacity=0.0,
    )
    ring.move_to(center)
    scale_factor = radius / 0.05
    anim = AnimationGroup(
        ring.animate.scale(scale_factor).set_stroke(opacity=0.0),
        run_time=run_time,
    )
    return ring, anim


def downstream_tracer(src, dst, curvature: float = 0.85, run_time: float = 1.10):
    """Return (mobject, animation). A curved amber arc from `src` to
    `dst` that persists for `run_time` while fading to invisible. Reads
    as the trajectory a FunctionCall receipt takes from the calling
    contract to its target — after the satellite has completed its
    travel, the tracer lingers so the eye registers "signal went that
    way".

    `curvature` is the arc angle in radians; 0.85 rad ≈ 49° gives a
    confident bow that reads at -ql render scale without distracting
    from the satellite's own travel.
    """
    arc = ArcBetweenPoints(
        start=np.array(src),
        end=np.array(dst),
        angle=curvature,
    )
    arc.set_stroke(color=SATELLITE_AMBER, width=3.4, opacity=0.88)
    anim = AnimationGroup(
        arc.animate.set_stroke(opacity=0.0),
        run_time=run_time,
    )
    return arc, anim


def decay_ember(center, n: int = 5, radius: float = 0.40, run_time: float = 0.8):
    """Return (mobject_group, animation). Small cluster of tiny red
    dots that drift outward + fade, evoking disintegration after the
    NEP-519 200-block expiry.
    """
    group = VGroup()
    # Deterministic sampling — reproducible across renders.
    rng = np.random.default_rng(seed=17)
    dots_end = []
    for _i in range(n):
        ang = rng.uniform(0.0, 2 * np.pi)
        r_end = rng.uniform(radius * 0.7, radius * 1.1)
        d = Dot(
            radius=0.05,
            color=FAILURE_RED,
            fill_opacity=0.95,
        )
        d.move_to(center)
        group.add(d)
        dots_end.append(np.array(center) + r_end * np.array([np.cos(ang), np.sin(ang), 0.0]))

    anims = []
    for d, end in zip(group, dots_end):
        anims.append(d.animate.move_to(end).set_opacity(0.0).scale(0.4))
    anim = AnimationGroup(*anims, run_time=run_time)
    return group, anim
