"""Convert markdown text to Qt-compatible HTML."""
import re
import html as _html

import ui.theme as T

_MONOSPACE = "Consolas, 'Courier New', monospace"


def render(text: str) -> str:
    """Return an HTML string suitable for QTextBrowser / QLabel rich text."""
    lines = text.split("\n")
    out: list[str] = []
    i = 0
    while i < len(lines):
        line = lines[i]

        # Fenced code block
        if line.startswith("```"):
            lang = line[3:].strip()
            code_lines: list[str] = []
            i += 1
            while i < len(lines) and not lines[i].startswith("```"):
                code_lines.append(lines[i])
                i += 1
            code = "\n".join(code_lines)
            out.append(_code_block(code, lang))
            i += 1
            continue

        # Horizontal rule
        if re.match(r"^(-{3,}|\*{3,}|_{3,})$", line.strip()):
            out.append(f'<hr style="border:none; border-top:1px solid {T.BG_BORDER}; margin:12px 0;">')
            i += 1
            continue

        # Headings
        m = re.match(r"^(#{1,6})\s+(.+)$", line)
        if m:
            level = len(m.group(1))
            sizes = {1: T.FONT_SIZES["2xl"], 2: T.FONT_SIZES["xl"],
                     3: T.FONT_SIZES["lg"], 4: T.FONT_SIZES["md"],
                     5: T.FONT_SIZES["base"], 6: T.FONT_SIZES["sm"]}
            sz = sizes.get(level, T.FONT_SIZES["base"])
            content = _inline(m.group(2))
            out.append(
                f'<p style="font-size:{sz}px; font-weight:600; color:{T.TEXT_PRIMARY}; '
                f'margin:16px 0 6px 0;">{content}</p>'
            )
            i += 1
            continue

        # Unordered list (with basic 2-level nesting)
        if re.match(r"^( {0,3})[\*\-\+]\s+", line):
            items: list[str] = []
            while i < len(lines) and re.match(r"^( {0,3})[\*\-\+]\s+", lines[i]):
                m2 = re.match(r"^( *)([\*\-\+])\s+(.*)$", lines[i])
                indent = len(m2.group(1)) if m2 else 0
                content = m2.group(3) if m2 else lines[i][2:]
                pad = "padding-left:30px;" if indent >= 2 else ""
                items.append(f'<li style="{pad}">{_inline(content)}</li>')
                i += 1
            out.append(
                f'<ul style="margin:6px 0 6px 0; padding-left:20px; color:{T.TEXT_PRIMARY};">'
                + "".join(items) + "</ul>"
            )
            continue

        # Ordered list
        if re.match(r"^\d+\.\s+", line):
            items = []
            while i < len(lines) and re.match(r"^\d+\.\s+", lines[i]):
                content = re.sub(r"^\d+\.\s+", "", lines[i])
                items.append(f"<li>{_inline(content)}</li>")
                i += 1
            out.append(
                f'<ol style="margin:6px 0 6px 0; padding-left:20px; color:{T.TEXT_PRIMARY};">'
                + "".join(items) + "</ol>"
            )
            continue

        # Table detection (pipe-delimited with separator row)
        if line.startswith("|") and i + 1 < len(lines) and re.match(r"^\|[-| :]+\|", lines[i + 1]):
            table_lines: list[str] = []
            while i < len(lines) and lines[i].startswith("|"):
                table_lines.append(lines[i])
                i += 1
            out.append(_table(table_lines))
            continue

        # Blockquote
        if line.startswith("> "):
            bq_lines: list[str] = []
            while i < len(lines) and lines[i].startswith("> "):
                bq_lines.append(_inline(lines[i][2:]))
                i += 1
            inner = "<br>".join(bq_lines)
            out.append(
                f'<div style="border-left:3px solid {T.BRAND_MUTED}; padding:4px 12px; '
                f'margin:6px 0; color:{T.TEXT_SECONDARY}; font-style:italic;">{inner}</div>'
            )
            continue

        # Empty line → paragraph break
        if line.strip() == "":
            out.append('<div style="height:8px;"></div>')
            i += 1
            continue

        # Normal paragraph
        out.append(
            f'<p style="margin:0 0 2px 0; line-height:1.8; color:{T.TEXT_PRIMARY};">'
            f'{_inline(line)}</p>'
        )
        i += 1

    return "".join(out)


# ── Inline formatting ─────────────────────────────────────────────────────────

def _inline(text: str) -> str:
    # Escape HTML first, but we'll re-inject safe tags
    text = _html.escape(text)

    # Bold + italic
    text = re.sub(r"\*\*\*(.+?)\*\*\*", r"<b><i>\1</i></b>", text)
    # Bold
    text = re.sub(r"\*\*(.+?)\*\*", r"<b>\1</b>", text)
    text = re.sub(r"__(.+?)__", r"<b>\1</b>", text)
    # Italic
    text = re.sub(r"\*(.+?)\*", r"<i>\1</i>", text)
    text = re.sub(r"_(.+?)_", r"<i>\1</i>", text)
    # Strikethrough
    text = re.sub(r"~~(.+?)~~", r"<s>\1</s>", text)
    # Links [text](url) — must run before html escaping modifies the brackets
    # Note: html.escape already ran, so & is &amp; — but brackets are safe
    text = re.sub(
        r"\[([^\]]+)\]\(([^)]+)\)",
        lambda m: (
            f'<a href="{m.group(2)}" style="color:{T.BRAND_PRIMARY}; '
            f'text-decoration:underline;">{m.group(1)}</a>'
        ),
        text,
    )
    # Inline code
    text = re.sub(
        r"`([^`]+)`",
        lambda m: (
            f'<code style="background:{T.BG_ELEVATED}; color:{T.BRAND_PRIMARY}; '
            f'font-family:{_MONOSPACE}; font-size:12px; '
            f'padding:1px 5px; border-radius:{T.RADIUS["sm"]}px;">'
            f"{_html.escape(m.group(1))}</code>"
        ),
        text,
    )
    return text


# ── Table ─────────────────────────────────────────────────────────────────────

def _table(lines: list) -> str:
    if len(lines) < 2:
        return ""
    headers = [c.strip() for c in lines[0].strip("|").split("|")]
    # Index 1 is the separator row — skip it
    rows = [
        [c.strip() for c in line.strip("|").split("|")]
        for line in lines[2:]
    ]
    th_cells = "".join(
        f'<th style="padding:6px 12px; border-bottom:1px solid {T.BG_BORDER}; '
        f'text-align:left; color:{T.TEXT_SECONDARY}; font-weight:600;">'
        f'{_inline(h)}</th>'
        for h in headers
    )
    tr_rows = "".join(
        "<tr>" + "".join(
            f'<td style="padding:6px 12px; border-bottom:1px solid {T.BG_BORDER}; '
            f'color:{T.TEXT_PRIMARY};">{_inline(cell)}</td>'
            for cell in row[:len(headers)]
        ) + "</tr>"
        for row in rows
    )
    return (
        f'<table style="border-collapse:collapse; width:100%; margin:8px 0; '
        f'background:{T.BG_ELEVATED}; border-radius:{T.RADIUS["md"]}px;">'
        f"<thead><tr>{th_cells}</tr></thead>"
        f"<tbody>{tr_rows}</tbody>"
        f"</table>"
    )


# ── Code block ────────────────────────────────────────────────────────────────

def _code_block(code: str, lang: str = "") -> str:
    escaped = _html.escape(code)
    lang_label = (
        f'<span style="color:{T.TEXT_TERTIARY}; font-size:11px; '
        f'font-family:{_MONOSPACE};">{lang}</span>'
        if lang else ""
    )
    return (
        f'<div style="background:{T.BG_ELEVATED}; border-radius:{T.RADIUS["md"]}px; '
        f'margin:8px 0; overflow:hidden;">'
        f'<div style="padding:6px 12px; border-bottom:1px solid {T.BG_BORDER}; '
        f'display:flex; justify-content:space-between;">{lang_label}</div>'
        f'<pre style="margin:0; padding:12px; font-family:{_MONOSPACE}; '
        f'font-size:12px; color:{T.TEXT_PRIMARY}; white-space:pre-wrap; '
        f'word-wrap:break-word;">{escaped}</pre>'
        f'</div>'
    )
