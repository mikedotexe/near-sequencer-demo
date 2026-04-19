"""Shared typography — DM Sans via Pango with explicit letter-spacing.

Manim's `Text` does not expose a letter-spacing knob; the Pango default
for a dense sans-serif at the small sizes we use (12–17 pt) reads as
*squished*. `MarkupText` does accept `<span letter_spacing>`, so we
wrap it here. All common primitives route through `kerned_text(...)`
so kerning and font family are tuned in one place.

Units: Pango's `letter_spacing` is integer *1/1024 of a point*, so
`letter_spacing=120` ≈ 0.12 pt of extra space per glyph pair.
"""

from __future__ import annotations

from manim import MarkupText

# Family resolved by fontconfig. If DM Sans is missing Pango silently
# falls back to the system sans; intentional graceful degradation.
DEFAULT_FONT = "DM Sans"

# Chosen by eye: loose enough to escape the "squished" feel at 12–17 pt
# without reading as a tracked display face. Dial here, not at call sites.
DEFAULT_LETTER_SPACING = 120


def _escape_markup(text: str) -> str:
    """Pango-escape markup metacharacters so plain text stays literal."""
    return (
        text.replace("&", "&amp;")
            .replace("<", "&lt;")
            .replace(">", "&gt;")
    )


def kerned_text(
    text: str,
    font_size: int,
    color: str,
    *,
    font: str = DEFAULT_FONT,
    letter_spacing: int = DEFAULT_LETTER_SPACING,
    weight: str = "NORMAL",
    line_spacing: float | None = None,
    **kwargs,
) -> MarkupText:
    """Return a MarkupText with consistent font + letter-spacing.

    Drop-in for `Text(text, font_size=..., color=...)` — same positioning,
    same .width/.height semantics, same submobject-per-glyph layout. The
    wrapping span carries letter_spacing so every glyph pair picks up
    the same loosening.
    """
    markup = f'<span letter_spacing="{letter_spacing}">{_escape_markup(text)}</span>'
    mt_kwargs = dict(
        font=font,
        font_size=font_size,
        color=color,
        weight=weight,
        **kwargs,
    )
    if line_spacing is not None:
        mt_kwargs["line_spacing"] = line_spacing
    return MarkupText(markup, **mt_kwargs)
