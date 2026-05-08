import sys
import os

# Ensure project root is on path
_ROOT = os.path.dirname(os.path.dirname(__file__))
if _ROOT not in sys.path:
    sys.path.insert(0, _ROOT)

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
