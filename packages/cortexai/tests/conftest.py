import sys
import types

import pytest
from PyQt5.QtWidgets import QApplication

# Provide a minimal theme stub so tests can import ui.theme without a running display
# when the real module is unavailable. If the real module already loaded, skip.
if "ui.theme" not in sys.modules:
    _theme_stub = types.ModuleType("ui.theme")
    for _attr, _val in [
        ("BG_BASE", "#0e0e16"),
        ("BG_SURFACE", "#13131e"),
        ("BG_ELEVATED", "#1a1a28"),
        ("BG_OVERLAY", "#222233"),
        ("BG_BORDER", "#2a2a3e"),
        ("BRAND_PRIMARY", "#d4a574"),
        ("BRAND_MUTED", "#8b6b47"),
        ("BRAND_HOVER", "#e0b585"),
        ("TEXT_PRIMARY", "#f0ede8"),
        ("TEXT_SECONDARY", "#9b97a0"),
        ("TEXT_TERTIARY", "#5a5760"),
        ("TEXT_ON_BRAND", "#1a1208"),
        ("USER_MSG_BG", "#1e1e2e"),
        ("SUCCESS", "#4caf80"),
        ("WARNING", "#f0a060"),
        ("ERROR", "#e05555"),
        ("ERROR_BG", "#2a1515"),
        ("SUCCESS_BG", "#0d2a1a"),
        ("WARNING_BG", "#2a1f0a"),
        ("INFO", "#60a5fa"),
        ("INFO_BG", "#0d1a2a"),
        ("ASSISTANT_MSG_BG", "transparent"),
        ("FONT_FAMILY", "Inter"),
        ("FONT_SIZES", {"xs": 11, "sm": 12, "base": 13, "md": 14, "lg": 16, "xl": 20, "2xl": 24, "3xl": 30}),
        ("FONT_WEIGHTS", {"normal": 400, "medium": 500, "semibold": 600, "bold": 700}),
        ("RADIUS", {"sm": 4, "md": 8, "lg": 12, "xl": 16, "2xl": 20, "full": 999}),
        ("SPACING", {"xs": 4, "sm": 6, "md": 8, "lg": 12, "xl": 16, "2xl": 24, "3xl": 32}),
    ]:
        setattr(_theme_stub, _attr, _val)
    sys.modules["ui.theme"] = _theme_stub


@pytest.fixture(scope="session", autouse=True)
def qapp():
    app = QApplication.instance() or QApplication([])
    yield app
