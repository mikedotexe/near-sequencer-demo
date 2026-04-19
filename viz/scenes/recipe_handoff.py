"""Recipe 4 — Atomic handoff.

Alice attaches NEAR to a yielded promise naming Bob as the recipient.
Either Bob resumes and the callback transfers funds to him atomically,
or the 200-block timeout fires and the callback refunds Alice. One
receipt scheduled at yield time carries both endings.

Two scenes: `RecipeHandoffClaim` (happy path, Bob claims) and
`RecipeHandoffTimeout` (no resume, Alice refunded). Each has a Live
variant driven by a translated testnet capture.

Run from `viz/`:

    manim -ql scenes/recipe_handoff.py RecipeHandoffClaim
    manim -ql scenes/recipe_handoff.py RecipeHandoffTimeout
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


# Three actors. Alice (left) signs the yield and resume, recipes
# contract (center) holds the yielded callback, Bob (right) is the
# nominated recipient — the transfer lands on him in claim mode and he
# stays visible-but-silent in timeout mode (nobody showed up to pull the
# trigger, funds go back to Alice).
_LAYOUT = {
    "alice":   [-5.0, -2.00, 0.0],
    "recipes": [ 0.0,  0.10, 0.0],
    "bob":     [ 5.0, -2.00, 0.0],
}


def build(
    scene,
    include_title: bool = True,
    pacing: float = 1.0,
    data_file: str = "recipe-handoff-claim-synthetic.json",
    title_text: str = "Recipe 4 \u2014 atomic handoff (claim)",
    idle_block_seconds: float = 0.18,
) -> None:
    timeline = load_timeline(VIZ_ROOT / "data" / data_file)

    if include_title:
        title = kerned_text(title_text, font_size=20, color=TEXT_LIGHT).to_edge(UP, buff=0.30)
        scene.add(title)

    player = TimelinePlayer(
        scene,
        timeline,
        block_seconds=0.55,
        idle_block_seconds=idle_block_seconds,
        orbit_radius=1.10,
        orbit_omega=0.55,
        background="cosmic",
        pacing=pacing,
    )
    player.place_actors(_LAYOUT)
    player.add_block_hud(corner=[5.50, -3.55, 0.0])
    player.add_legend()
    player.play()


class RecipeHandoffClaim(MovingCameraScene):
    def construct(self):
        build(self)
        self.wait(1.2)


class RecipeHandoffClaimLive(MovingCameraScene):
    def construct(self):
        build(self, data_file="recipe-handoff-claim-live-01.json")
        self.wait(1.2)


class RecipeHandoffTimeout(MovingCameraScene):
    def construct(self):
        # Compress the 200-block wait the same way recipe_timeout does.
        build(
            self,
            data_file="recipe-handoff-timeout-synthetic.json",
            title_text="Recipe 4 \u2014 atomic handoff (timeout)",
            idle_block_seconds=0.018,
        )
        self.wait(1.2)


class RecipeHandoffTimeoutLive(MovingCameraScene):
    def construct(self):
        build(
            self,
            data_file="recipe-handoff-timeout-live-01.json",
            title_text="Recipe 4 \u2014 atomic handoff (timeout)",
            idle_block_seconds=0.018,
        )
        self.wait(1.2)
