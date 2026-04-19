"""Recipe 2 — Timeout: the callback fires even without a resume.

NEP-519 guarantees the yielded callback fires exactly once: either via
an explicit resume with the payload, or (after the fixed 200-block
budget elapses) with `PromiseError` in place of it. The synthetic
scene compresses the 200-block wait visually via the block HUD's
advancing counter across a long idle.

Run from `viz/`:

    manim -ql scenes/recipe_timeout.py RecipeTimeout
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


_LAYOUT = {
    "user":    [-5.0, -2.00, 0.0],
    "recipes": [ 0.0,  0.10, 0.0],
}


def build(scene, include_title: bool = True, pacing: float = 1.0, data_file: str = "recipe-timeout-synthetic.json") -> None:
    timeline = load_timeline(VIZ_ROOT / "data" / data_file)

    if include_title:
        title = kerned_text(
            "Recipe 2 \u2014 timeout (200-block budget)",
            font_size=20, color=TEXT_LIGHT,
        ).to_edge(UP, buff=0.30)
        scene.add(title)

    # Slightly faster idle so the 200-block wait compresses into a
    # watchable span — the scene's whole point is "time elapses, then
    # the callback fires anyway." Budget ~3.5 s of scene time between
    # yield and timeout so the HUD counter sweep reads clearly.
    player = TimelinePlayer(
        scene,
        timeline,
        block_seconds=0.55,
        idle_block_seconds=0.018,    # 1/10 of basic; compresses long idle
        orbit_radius=1.10,
        orbit_omega=0.55,
        background="cosmic",
        pacing=pacing,
    )
    player.place_actors(_LAYOUT)
    player.add_block_hud(corner=[5.50, -3.55, 0.0])
    player.add_legend()
    player.play()


class RecipeTimeout(MovingCameraScene):
    def construct(self):
        build(self)
        self.wait(1.2)


class RecipeTimeoutLive(MovingCameraScene):
    """Live variant driven by the latest translated testnet capture."""

    def construct(self):
        build(self, data_file="recipe-timeout-live-01.json")
        self.wait(1.2)
