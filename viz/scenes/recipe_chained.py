"""Recipe 3 — Chained: resume triggers a downstream call with callback.

The canonical NEAR cross-contract composition, gated on a yielded
resume. tx1 yields; tx2 resumes with a delta. on_chained_resumed
dispatches counter.increment / decrement and chains
`.then(on_counter_observed)`. Only after the counter's truthful
return value flows back through #[callback_result] does the recipe's
own receipt resolve.

Run from `viz/`:

    manim -ql scenes/recipe_chained.py RecipeChained
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


# Caller on the left; recipes centre; counter on the right. downstream_call
# + downstream_return traverse the recipes→counter gap, which is the whole
# visual teaching moment of this recipe.
_LAYOUT = {
    "user":    [-5.5, -2.20, 0.0],
    "recipes": [-1.5,  0.10, 0.0],
    "counter": [ 3.5,  0.10, 0.0],
}


def build(scene, include_title: bool = True, pacing: float = 1.0, data_file: str = "recipe-chained-synthetic.json") -> None:
    timeline = load_timeline(VIZ_ROOT / "data" / data_file)

    if include_title:
        title = kerned_text(
            "Recipe 3 \u2014 chained (resume + .then(callback))",
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


class RecipeChained(MovingCameraScene):
    def construct(self):
        build(self)
        self.wait(1.2)


class RecipeChainedLive(MovingCameraScene):
    """Live variant driven by the latest translated testnet capture."""

    def construct(self):
        build(self, data_file="recipe-chained-live-01.json")
        self.wait(1.2)
