"""Ambient cosmic background.

`apply_cosmic_background(scene)` paints a cosmic backdrop: a base
dark colour, two oversized faint nebula blobs (deep blue + violet)
for layered depth, and a seeded-random starfield of faint dots — a
subset of which twinkle with a slow opacity modulation. Purely
aesthetic; no interaction with scene content. Reproducible across
renders — RNG seed is fixed.
"""

from __future__ import annotations

import numpy as np
from manim import Circle, Dot, TAU, VGroup

from .palette import BG_CENTER, NEBULA_BLUE, NEBULA_VIOLET, STAR_COLOR


STAR_COUNT = 25
STAR_SEED = 42
FRAME_X = 7.0
FRAME_Y = 3.8

# ~1 in 5 stars gently pulse opacity; the rest stay static so the
# frame doesn't read as "shimmering" overall — the eye picks up on
# isolated twinklers instead.
TWINKLE_FRACTION = 0.2
TWINKLE_PERIOD_S = 5.5  # long enough to read as "alive", not flickery
TWINKLE_AMPLITUDE = 0.25  # multiplier on each twinkler's base opacity


def _nebula_blob(center: np.ndarray, color: str, radius: float, opacity: float) -> Circle:
    """Return an oversized, extremely low-opacity Circle to suggest a
    cloud of dust. No stroke — reads as a soft diffuse light smear
    against the near-black background.
    """
    return Circle(
        radius=radius,
        color=color,
        fill_color=color,
        fill_opacity=opacity,
        stroke_width=0,
    ).move_to(center)


def apply_cosmic_background(scene, seed: int = STAR_SEED, count: int = STAR_COUNT) -> VGroup | None:
    """Set the cosmic background colour and stamp a starfield.

    Idempotent: if this scene already has cosmic bg applied, returns
    the existing starfield without stamping a second set of stars.
    Overview-style scenes apply it once at the top; individual scenes
    that also declare `background="cosmic"` then become no-ops inside
    overview while remaining functional when rendered standalone.

    Returns the VGroup of stars so callers can clean them up on scene
    teardown if needed. Called *before* any content is added so the
    stars (and nebula blobs) sit at the bottom of the z-stack.
    """
    existing = getattr(scene, "_cosmic_starfield", None)
    if existing is not None:
        return existing
    scene.camera.background_color = BG_CENTER

    # Nebula blobs — two oversized faint discs, positioned off-centre
    # so the frame has a quiet sense of direction. Placed before the
    # stars so stars render on top and still punch through.
    nebulae = VGroup(
        _nebula_blob(np.array([-3.2, 1.4, 0.0]), NEBULA_BLUE,   radius=4.2, opacity=0.10),
        _nebula_blob(np.array([ 3.6, -1.1, 0.0]), NEBULA_VIOLET, radius=3.6, opacity=0.08),
    )
    scene.add(nebulae)

    rng = np.random.default_rng(seed)
    stars = VGroup()
    twinklers: list[tuple[Dot, float, float]] = []  # (dot, base_opacity, phase_offset)
    for _i in range(count):
        x = rng.uniform(-FRAME_X, FRAME_X)
        y = rng.uniform(-FRAME_Y, FRAME_Y)
        r = rng.uniform(0.010, 0.028)
        op = rng.uniform(0.18, 0.55)
        d = Dot(
            point=np.array([x, y, 0.0]),
            radius=r,
            color=STAR_COLOR,
            fill_opacity=op,
            stroke_width=0,
        )
        stars.add(d)
        if rng.random() < TWINKLE_FRACTION:
            twinklers.append((d, op, rng.uniform(0.0, TAU)))
    scene.add(stars)

    # Twinkle updater — one function walks every twinkler and
    # modulates its fill_opacity around the base value. Running one
    # updater for the whole set is cheaper than N per-dot updaters.
    if twinklers:
        def _twinkle(_mob, dt):
            _twinkle.t += dt
            t = _twinkle.t
            for dot, base_op, phase in twinklers:
                wave = np.sin(t * (TAU / TWINKLE_PERIOD_S) + phase)
                dot.set_opacity(base_op * (1.0 + TWINKLE_AMPLITUDE * wave))
        _twinkle.t = 0.0
        stars.add_updater(_twinkle)

    scene._cosmic_starfield = stars
    scene._cosmic_nebulae = nebulae
    return stars
