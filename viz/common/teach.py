"""First-appearance teach cards.

Each event type's first appearance in a scene shows a small panel card
with a **title** (the event identifier) and a one-sentence **body**
that maps it to the underlying NEAR primitive. Purely pedagogical —
fades automatically after a short dwell window. Richer than the older
"stacked short callout" idiom because the body text names the contract
method, the NEP-519 constant, or the decision point each event
represents, instead of paraphrasing the event name.

Cards stack from top-center downward; keep-alive is kept short so
back-to-back first-appearance events (e.g. resume_data +
resume_action in the same block) don't pile up against the scene's
content zone.
"""

from __future__ import annotations

import numpy as np
from manim import (
    VGroup,
    Rectangle,
    RoundedRectangle,
    DOWN,
    LEFT,
)

from .palette import (
    CONTRACT_TEAL,
    CONTRACT_STROKE,
    SATELLITE_AMBER,
    TEXT_LIGHT,
)
from .typography import kerned_text, serif_text


def build_teach_card(
    title: str,
    body: str,
    max_body_width: float = 5.6,
    kind: str = "definition",
) -> VGroup:
    """Return a panel VGroup with a title line and an explanatory body.

    `kind` distinguishes two registers, rendered in different type:
    - "definition" (default) — vocabulary card, fires first time an
      event type appears. DM Sans (clean, modernist). Teal panel.
    - "narrative" — thesis / question card, fires at author-chosen
      blocks to frame what the viewer is watching. Palatino / serif
      fallback (editorial). Same panel layout, but a thin amber
      left-edge stripe + serif type signal "this is a thought, not a
      label."
    """
    if kind == "narrative":
        # Serif register — slightly larger body font compensates for
        # serif's typically shorter x-height so the two registers read
        # at comparable optical density.
        title_mob = serif_text(title, font_size=19, color=TEXT_LIGHT)
        body_mob = serif_text(body, font_size=14, color=TEXT_LIGHT)
    else:
        # Definition titles often contain snake_case identifiers like
        # `settle — on_promise_resolved`; underscores look gappy under
        # the default 120 spacing, so tighten titles to 60. Body text
        # stays at 120 for prose readability.
        title_mob = kerned_text(title, font_size=17, color=TEXT_LIGHT,
                                letter_spacing=60)
        body_mob = kerned_text(body, font_size=13, color=TEXT_LIGHT)

    if body_mob.width > max_body_width:
        # Rather than silently chopping, downsize the font slightly so
        # long bodies still fit. If that still doesn't fit, the caller
        # should rewrite the body — these strings are pedagogy and
        # should be hand-tuned, not auto-wrapped.
        scale = max_body_width / body_mob.width
        body_mob.scale(scale)

    stack = VGroup(title_mob, body_mob).arrange(DOWN, buff=0.08, aligned_edge=LEFT)

    pad_x, pad_y = 0.24, 0.14
    panel = RoundedRectangle(
        width=stack.width + 2 * pad_x,
        height=stack.height + 2 * pad_y,
        corner_radius=0.12,
        color=CONTRACT_STROKE,
        fill_color=CONTRACT_TEAL,
        fill_opacity=0.16,
        stroke_width=1.2,
        stroke_opacity=0.38,
    )
    panel.move_to(stack.get_center())
    group = VGroup(panel, stack)
    if kind == "narrative":
        stripe = Rectangle(
            width=0.06,
            height=panel.height * 0.86,
            color=SATELLITE_AMBER,
            fill_color=SATELLITE_AMBER,
            fill_opacity=0.60,
            stroke_width=0,
        )
        stripe.move_to(panel.get_left() + np.array([0.08, 0.0, 0.0]))
        group.add(stripe)
    return group
