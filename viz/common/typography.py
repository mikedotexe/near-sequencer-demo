"""Shared typography — DM Sans for the UI register (labels, HUD,
vocabulary teach cards), Palatino / serif fallback for the narrator
register (narrative teach cards).

Manim's `Text` does not expose a letter-spacing knob; the Pango default
for a dense sans-serif at the small sizes we use (12–17 pt) reads as
*squished*. `MarkupText` does accept `<span letter_spacing>`, so we
wrap it here. Two helpers share the same machinery:

- `kerned_text(...)` — DM Sans. Default for titles, labels, HUD, and
  vocabulary teach cards. Clean modernist register.
- `serif_text(...)` — Palatino / fallback. Narrator voice, used for
  narrative teach cards. The type difference signals "this is a
  thought" vs "this is a label" without needing prose to make the
  distinction.

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

# Editorial serif. Manim's MarkupText takes a single font name (not a
# CSS-style fallback list), so pick one that's reliably available on the
# macOS / Linux fontconfig list. Palatino is built into macOS and
# packaged as `fonts-urw-base35` on Debian/Ubuntu, with an editorial
# feel suitable for narrator voice. Overridable per-call for renders on
# systems that have something more distinctive installed (e.g. EB
# Garamond, Iowan Old Style).
SERIF_FONT = "Palatino"

# Serifs already have generous x-heights and built-in spacing — the wide
# letter_spacing that sans needs would read as affected here. A hair of
# loosening keeps them from feeling cramped without announcing.
SERIF_LETTER_SPACING = 50


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


def serif_text(
    text: str,
    font_size: int,
    color: str,
    *,
    font: str = SERIF_FONT,
    letter_spacing: int = SERIF_LETTER_SPACING,
    weight: str = "NORMAL",
    line_spacing: float | None = None,
    **kwargs,
) -> MarkupText:
    """Return a MarkupText in the serif (narrator) register.

    Same signature and semantics as `kerned_text` — only the default
    font family and letter-spacing differ. Use for narrative teach
    cards and any other "narrator voice" text. Keep sans for labels,
    vocab, HUD, and legends.
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
