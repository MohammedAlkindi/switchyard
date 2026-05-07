import sys
import os
import types

# Ensure project root is on path
_ROOT = os.path.dirname(os.path.dirname(__file__))
if _ROOT not in sys.path:
    sys.path.insert(0, _ROOT)

# Provide a stub for ui.theme before importing the renderer so PyQt5 is not required
theme = types.ModuleType("ui.theme")
theme.BG_ELEVATED = "#1a1a24"
theme.BG_BORDER = "#2a2a3a"
theme.BRAND_PRIMARY = "#d4a574"
theme.BRAND_MUTED = "#8b6b47"
theme.TEXT_PRIMARY = "#f0ede8"
theme.TEXT_SECONDARY = "#9b97a0"
theme.TEXT_TERTIARY = "#5a5760"
theme.FONT_SIZES = {"xs": 11, "sm": 12, "base": 13, "md": 14,
                    "lg": 16, "xl": 20, "2xl": 24, "3xl": 30}
theme.RADIUS = {"sm": 4, "md": 8, "lg": 12, "xl": 16, "2xl": 20, "full": 999}

# Register ui and ui.components as module stubs so importlib can find them
ui_mod = types.ModuleType("ui")
ui_mod.__path__ = [os.path.join(_ROOT, "ui")]
ui_mod.__package__ = "ui"
sys.modules["ui"] = ui_mod

ui_comp = types.ModuleType("ui.components")
ui_comp.__path__ = [os.path.join(_ROOT, "ui", "components")]
ui_comp.__package__ = "ui.components"
sys.modules["ui.components"] = ui_comp
sys.modules["ui.theme"] = theme
ui_mod.theme = theme

from ui.components.markdown_renderer import render, _inline  # noqa: E402


def test_bold():
    assert "<b>hello</b>" in _inline("**hello**")


def test_italic():
    result = _inline("*world*")
    assert "<i>world</i>" in result


def test_inline_code():
    result = _inline("`code`")
    assert "<code" in result
    assert "code" in result


def test_heading():
    result = render("# Hello")
    assert "Hello" in result
    assert "font-weight:600" in result


def test_code_block():
    result = render("```python\nprint('hi')\n```")
    assert "print" in result
    assert "pre" in result


def test_blockquote():
    result = render("> quoted text")
    assert "border-left" in result
    assert "quoted text" in result


def test_link():
    result = _inline("[click here](https://example.com)")
    assert "href" in result
    assert "click here" in result
    assert "example.com" in result


def test_strikethrough():
    result = _inline("~~deleted~~")
    assert "<s>deleted</s>" in result


def test_horizontal_rule():
    result = render("---")
    assert "<hr" in result


def test_ordered_list():
    result = render("1. first\n2. second")
    assert "<ol" in result
    assert "first" in result
    assert "second" in result
