"""Recipe 1 — Basic cross-tx yield + resume.

The simplest NEP-519 mechanic. tx1 yields a promise; tx2 resumes it
with a payload; the callback fires and resolves ok.

Run from `viz/`:

    manim -ql scenes/recipe_basic.py RecipeBasic
    manim -pql scenes/recipe_basic.py RecipeBasic

See ../DESIGN.md for the orbital-vocabulary rationale.
"""

from __future__ import annotations

import sys
from pathlib import Path

VIZ_ROOT = Path(__file__).resolve().parent.parent
if str(VIZ_ROOT) not in sys.path:
    sys.path.insert(0, str(VIZ_ROOT))

from manim import MovingCameraScene, UP  # noqa: E402

from common.timeline import TimelinePlayer, load_timeline  # noqa: E402
from common.palette import TEXT_LIGHT  # noqa: E402
from common.typography import kerned_text  # noqa: E402


# One caller + one contract. Horizontal axis reads left→right: caller
# signs → recipes contract holds the yielded callback. Small layout —
# the recipe is deliberately minimal, visually as well as structurally.
_LAYOUT = {
    "user":    [-5.0, -2.00, 0.0],
    "recipes": [ 0.0,  0.10, 0.0],
}


def build(scene, include_title: bool = True, pacing: float = 1.0, data_file: str = "recipe-basic-synthetic.json") -> None:
    timeline = load_timeline(VIZ_ROOT / "data" / data_file)

    if include_title:
        title = kerned_text(
            "Recipe 1 \u2014 basic yield + resume",
            font_size=20, color=TEXT_LIGHT,
        ).to_edge(UP, buff=0.30)
        scene.add(title)

    player = TimelinePlayer(
        scene,
        timeline,
        block_seconds=0.55,
        idle_block_seconds=0.18,
        orbit_radius=1.10,
        orbit_omega=0.55,
        background="cosmic",
        pacing=pacing,
    )
    player.place_actors(_LAYOUT)
    player.add_block_hud(corner=[5.50, -3.55, 0.0])
    player.add_legend()
    player.play()


class RecipeBasic(MovingCameraScene):
    def construct(self):
        build(self)
        self.wait(1.2)


class RecipeBasicLive(MovingCameraScene):
    """Live variant driven by the latest translated testnet capture."""

    def construct(self):
        build(self, data_file="recipe-basic-live-01.json")
        self.wait(1.2)
