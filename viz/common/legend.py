"""Persistent on-screen legend.

Small vertical key that makes the colour / shape semantics explicit so
a cold viewer can decode the scene without prior context. Every entry
is a tight row: a glyph (matching a scene primitive) + one short label.

Placed at the left edge by default, below the title. Kept small — the
legend should orient, not dominate.
"""

from __future__ import annotations

import numpy as np
from manim import (
    VGroup,
    Circle,
    RoundedRectangle,
    LEFT,
    RIGHT,
)

from .palette import (
    CONTRACT_TEAL,
    CONTRACT_STROKE,
    SATELLITE_AMBER,
    SATELLITE_EDGE,
    PERSON_ORANGE,
    PERSON_EDGE,
    SUCCESS_GREEN,
    FAILURE_RED,
    TEXT_LIGHT,
)
from .typography import kerned_text


def _swatch(fill: str, stroke: str, radius: float = 0.13):
    return Circle(
        radius=radius,
        color=stroke,
        fill_color=fill,
        fill_opacity=0.9,
        stroke_width=1.3,
    )


def _row(glyph, text: str, font_size: int = 12):
    label = kerned_text(text, font_size=font_size, color=TEXT_LIGHT)
    label.next_to(glyph, direction=RIGHT, buff=0.13)
    row = VGroup(glyph, label)
    return row


def build_legend() -> VGroup:
    """Return the full legend VGroup, positioned at the origin.

    Caller places it via `.move_to(...)` or `.to_edge(...)`. The
    layout is keyed off `row_height` so rows stay aligned regardless
    of glyph size. Rows sit inside a rounded panel (translucent
    teal-black) so the legend reads as a deliberate UI element, not
    loose annotations.
    """
    row_height = 0.32
    rows = [
        _row(_swatch(CONTRACT_TEAL, CONTRACT_STROKE, radius=0.15),
             "contract"),
        _row(_swatch(SATELLITE_AMBER, SATELLITE_EDGE, radius=0.11),
             "pending callback"),
        _row(_swatch(PERSON_ORANGE, PERSON_EDGE, radius=0.12),
             "user · calls run_sequence"),
        _row(_swatch(SUCCESS_GREEN, SATELLITE_EDGE, radius=0.11),
             "completed ok"),
        _row(_swatch(FAILURE_RED, SATELLITE_EDGE, radius=0.11),
             "failed or decayed"),
    ]
    rows_group = VGroup(*rows)
    # Stack rows top-down; align glyphs to a common left edge so the
    # labels form a tidy column regardless of glyph radius.
    for i, row in enumerate(rows):
        row.shift(np.array([0.0, -i * row_height, 0.0]))
    target_x = rows[0][0].get_left()[0]
    for row in rows:
        glyph = row[0]
        shift = target_x - glyph.get_left()[0]
        row.shift(np.array([shift, 0.0, 0.0]))

    # Panel — subtle rounded backdrop so the legend looks intentional.
    pad_x, pad_y = 0.18, 0.14
    w = rows_group.width + 2 * pad_x
    h = rows_group.height + 2 * pad_y
    panel = RoundedRectangle(
        width=w, height=h,
        corner_radius=0.14,
        color=CONTRACT_STROKE,
        fill_color=CONTRACT_TEAL,
        fill_opacity=0.12,
        stroke_width=1.2,
        stroke_opacity=0.35,
    )
    panel.move_to(rows_group.get_center())

    group = VGroup(panel, rows_group)
    return group
