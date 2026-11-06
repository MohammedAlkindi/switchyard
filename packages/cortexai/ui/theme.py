import sys
from PyQt5.QtGui import QFont, QFontDatabase

# ── Colour Palette ────────────────────────────────────────────────────────────

BG_BASE        = "#0a0a0f"
BG_SURFACE     = "#111118"
BG_ELEVATED    = "#1a1a24"
BG_OVERLAY     = "#22222f"
BG_BORDER      = "#2a2a3a"

BRAND_PRIMARY  = "#d4a574"
BRAND_HOVER    = "#e8b896"
BRAND_MUTED    = "#8b6b47"

TEXT_PRIMARY   = "#f0ede8"
TEXT_SECONDARY = "#9b97a0"
TEXT_TERTIARY  = "#5a5760"
TEXT_ON_BRAND  = "#0a0a0f"

SUCCESS        = "#4ade80"
SUCCESS_BG     = "#0d2a1a"
WARNING        = "#f59e0b"
WARNING_BG     = "#2a1f0a"
ERROR          = "#f87171"
ERROR_BG       = "#2a0d0d"
INFO           = "#60a5fa"
INFO_BG        = "#0d1a2a"

USER_MSG_BG    = "#1e1e2e"
ASSISTANT_MSG_BG = "transparent"

# ── Typography ────────────────────────────────────────────────────────────────

FONT_FAMILY: str = "Segoe UI"

FONT_SIZES = {
    "xs":    11,
    "sm":    12,
    "base":  13,
    "md":    14,
    "lg":    16,
    "xl":    20,
    "2xl":   24,
    "3xl":   30,
}

FONT_WEIGHTS = {
    "normal":   400,
    "medium":   500,
    "semibold": 600,
    "bold":     700,
}

# ── Spacing & Geometry ────────────────────────────────────────────────────────

RADIUS = {
    "sm":   4,
    "md":   8,
    "lg":   12,
    "xl":   16,
    "2xl":  20,
    "full": 999,
}

SPACING = {
    "xs":  4,
    "sm":  8,
    "md":  12,
    "lg":  16,
    "xl":  24,
    "2xl": 32,
    "3xl": 48,
}


_FONTS_INITIALIZED = False


def init_fonts() -> str:
    global FONT_FAMILY, _FONTS_INITIALIZED
    if _FONTS_INITIALIZED:
        return FONT_FAMILY
    _FONTS_INITIALIZED = True
    db = QFontDatabase()
    families = db.families()
    for preferred in ["Inter", "Segoe UI", "SF Pro Display", "Ubuntu"]:
        if preferred in families:
            FONT_FAMILY = preferred
            break
    else:
        FONT_FAMILY = "Arial"
    return FONT_FAMILY


def make_font(size_key: str = "base", weight_key: str = "normal", italic: bool = False) -> QFont:
    size   = FONT_SIZES.get(size_key, 13)
    weight = FONT_WEIGHTS.get(weight_key, 400)
    f = QFont(FONT_FAMILY, size)
    f.setWeight(weight)
    f.setItalic(italic)
    return f
