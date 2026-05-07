import logging
from datetime import datetime

from PyQt5.QtWidgets import (
    QWidget, QVBoxLayout, QHBoxLayout, QLabel, QPushButton,
    QTextBrowser, QApplication, QSizePolicy,
)
from PyQt5.QtCore import Qt, pyqtSignal, QTimer, QPropertyAnimation, QEasingCurve
from PyQt5.QtGui import QFont, QTextCursor

import ui.theme as T
from ui.components.markdown_renderer import render

log = logging.getLogger("CortexAI")


class UserBubble(QWidget):
    """Right-aligned user message pill."""

    def __init__(self, text: str, timestamp: str = "", parent=None):
        super().__init__(parent)
        self.setAttribute(Qt.WA_StyledBackground, True)
        self.setStyleSheet("background: transparent;")

        outer = QVBoxLayout(self)
        outer.setContentsMargins(T.SPACING["3xl"], 0, 0, 0)
        outer.setSpacing(2)

        # Bubble
        bubble_row = QHBoxLayout()
        bubble_row.addStretch()

        bubble = QLabel()
        bubble.setWordWrap(True)
        bubble.setTextFormat(Qt.PlainText)
        bubble.setText(text)
        bubble.setFont(QFont(T.FONT_FAMILY, T.FONT_SIZES["md"]))
        bubble.setStyleSheet(
            f"background: {T.USER_MSG_BG}; color: {T.TEXT_PRIMARY}; "
            f"border-radius: {T.RADIUS['xl']}px; "
            f"padding: {T.SPACING['sm']}px {T.SPACING['lg']}px; "
            f"line-height: 1.6;"
        )
        bubble.setSizePolicy(QSizePolicy.Preferred, QSizePolicy.Minimum)
        bubble_row.addWidget(bubble)
        outer.addLayout(bubble_row)

        # Timestamp (shown on hover via CSS trick — we use a timer approach)
        if timestamp:
            self._ts_label = QLabel(timestamp)
            self._ts_label.setFont(QFont(T.FONT_FAMILY, T.FONT_SIZES["xs"]))
            self._ts_label.setStyleSheet(
                f"color: {T.TEXT_TERTIARY}; background: transparent;"
            )
            self._ts_label.setAlignment(Qt.AlignRight)
            self._ts_label.hide()
            outer.addWidget(self._ts_label)
        else:
            self._ts_label = None

    def enterEvent(self, _e):
        if self._ts_label:
            self._ts_label.show()

    def leaveEvent(self, _e):
        if self._ts_label:
            self._ts_label.hide()

    def reset(self):
        pass


class AssistantBubble(QWidget):
    """Left-aligned assistant message with markdown rendering."""

    copy_requested   = pyqtSignal(str)
    regen_requested  = pyqtSignal()

    def __init__(self, model_name: str = "", parent=None):
        super().__init__(parent)
        self.setAttribute(Qt.WA_StyledBackground, True)
        self.setStyleSheet("background: transparent;")
        self._raw_text  = ""
        self._streaming = False

        outer = QVBoxLayout(self)
        outer.setContentsMargins(0, 0, T.SPACING["3xl"], 0)
        outer.setSpacing(T.SPACING["sm"])

        # Header row: logo + model badge
        hdr = QHBoxLayout()
        hdr.setSpacing(T.SPACING["sm"])

        logo = QLabel("C")
        logo.setFixedSize(20, 20)
        logo.setAlignment(Qt.AlignCenter)
        logo.setStyleSheet(
            f"background: {T.BRAND_PRIMARY}; color: {T.TEXT_ON_BRAND}; "
            f"border-radius: {T.RADIUS['md']}px; font-size: 10px; font-weight: 700;"
        )
        hdr.addWidget(logo)

        if model_name:
            model_lbl = QLabel(model_name)
            model_lbl.setFont(QFont(T.FONT_FAMILY, T.FONT_SIZES["xs"]))
            model_lbl.setStyleSheet(f"color: {T.TEXT_TERTIARY}; background: transparent;")
            hdr.addWidget(model_lbl)
        hdr.addStretch()
        outer.addLayout(hdr)

        # Message body
        self._body = QTextBrowser()
        self._body.setOpenExternalLinks(True)
        self._body.setReadOnly(True)
        self._body.setFont(QFont(T.FONT_FAMILY, T.FONT_SIZES["md"]))
        self._body.setStyleSheet(
            f"QTextBrowser {{ background: transparent; border: none; "
            f"color: {T.TEXT_PRIMARY}; padding: 0; }}"
            f"QScrollBar {{ width: 0px; }}"
        )
        self._body.document().setDefaultStyleSheet(
            f"body {{ font-family: '{T.FONT_FAMILY}'; font-size: {T.FONT_SIZES['md']}px; "
            f"color: {T.TEXT_PRIMARY}; line-height: 1.8; }}"
            f"code {{ font-family: Consolas, monospace; }}"
            f"pre  {{ margin: 0; }}"
        )
        # Disable scrollbar — parent scroll area handles scrolling
        self._body.setVerticalScrollBarPolicy(Qt.ScrollBarAlwaysOff)
        self._body.setHorizontalScrollBarPolicy(Qt.ScrollBarAlwaysOff)
        self._body.setSizePolicy(QSizePolicy.Expanding, QSizePolicy.Minimum)
        outer.addWidget(self._body)

        # Cursor timer for streaming
        self._cursor_visible = True
        self._cursor_timer   = QTimer(self)
        self._cursor_timer.setInterval(530)
        self._cursor_timer.timeout.connect(self._blink_cursor)

        # Render debounce — flush pending tokens at ~12fps instead of per token
        self._pending_tokens: list = []
        self._render_timer = QTimer(self)
        self._render_timer.setInterval(80)
        self._render_timer.timeout.connect(self._flush_tokens)

        # Action bar (hidden until hover)
        self._action_bar = _ActionBar()
        self._action_bar.hide()
        self._action_bar.copy_clicked.connect(lambda: self.copy_requested.emit(self._raw_text))
        self._action_bar.regen_clicked.connect(self.regen_requested)
        outer.addWidget(self._action_bar)

    # ── Content API ───────────────────────────────────────────────────────────

    def start_stream(self):
        self._raw_text  = ""
        self._streaming = True
        self._pending_tokens = []
        self._cursor_timer.start()
        self._body.setHtml(f'<span style="color:{T.TEXT_TERTIARY};">|</span>')

    def append_token(self, token: str):
        self._raw_text += token
        self._pending_tokens.append(token)
        if not self._render_timer.isActive():
            self._render_timer.start()

    def _flush_tokens(self):
        if not self._pending_tokens:
            return
        self._pending_tokens.clear()
        html = render(self._raw_text) + (
            f'<span style="color:{T.TEXT_PRIMARY}; font-weight:600;">|</span>'
            if self._streaming else ""
        )
        self._body.setHtml(html)
        self._adjust_height()

    def finish_stream(self):
        self._render_timer.stop()
        self._pending_tokens.clear()
        self._streaming = False
        self._cursor_timer.stop()
        self._body.setHtml(render(self._raw_text))
        self._adjust_height()

    def set_text(self, text: str):
        """Set full text (non-streaming)."""
        self._raw_text  = text
        self._streaming = False
        self._body.setHtml(render(text))
        self._adjust_height()

    def get_text(self) -> str:
        return self._raw_text

    # ── Internal ──────────────────────────────────────────────────────────────

    def _blink_cursor(self):
        if not self._streaming:
            return
        self._cursor_visible = not self._cursor_visible
        cursor_html = (
            f'<span style="color:{T.TEXT_PRIMARY}; font-weight:600;">|</span>'
            if self._cursor_visible else
            '<span style="color:transparent;">|</span>'
        )
        html = render(self._raw_text) + cursor_html
        self._body.setHtml(html)

    def _adjust_height(self):
        QTimer.singleShot(0, self._do_adjust_height)

    def _do_adjust_height(self):
        if self._body.viewport().width() < 10:
            return
        doc = self._body.document()
        doc.setTextWidth(self._body.viewport().width())
        h = int(doc.size().height()) + 4
        self._body.setFixedHeight(max(h, 20))

    def resizeEvent(self, event):
        super().resizeEvent(event)
        self._adjust_height()

    def enterEvent(self, _e):
        if not self._streaming:
            self._action_bar.show()

    def leaveEvent(self, _e):
        # Small delay so the action bar doesn't vanish when cursor moves to a button inside it
        QTimer.singleShot(80, self._hide_action_bar_if_not_hovered)

    def _hide_action_bar_if_not_hovered(self):
        if not self.underMouse():
            self._action_bar.hide()

    def reset(self):
        self._raw_text = ""
        self._streaming = False
        self._pending_tokens = []
        self._render_timer.stop()
        self._cursor_timer.stop()
        self._body.clear()
        self._action_bar.hide()


class _ActionBar(QWidget):
    copy_clicked  = pyqtSignal()
    regen_clicked = pyqtSignal()

    def __init__(self, parent=None):
        super().__init__(parent)
        self.setAttribute(Qt.WA_StyledBackground, True)
        self.setStyleSheet("background: transparent;")

        row = QHBoxLayout(self)
        row.setContentsMargins(0, 0, 0, 0)
        row.setSpacing(T.SPACING["xs"])

        for label, tip, sig in (
            ("Copy",  "Copy response",    self.copy_clicked),
            ("Retry", "Regenerate",       self.regen_clicked),
            ("👍",    "Good response",    None),
            ("👎",    "Bad response",     None),
        ):
            btn = _IconBtn(label, tip)
            if sig:
                btn.clicked.connect(sig)
            row.addWidget(btn)

        row.addStretch()

    def reset(self):
        pass


class _IconBtn(QPushButton):
    def __init__(self, symbol: str, tooltip: str, parent=None):
        super().__init__(symbol, parent)
        self.setFixedSize(28, 28)
        self.setToolTip(tooltip)
        self.setCursor(Qt.PointingHandCursor)
        self.setStyleSheet(
            f"QPushButton {{ background: transparent; color: {T.TEXT_TERTIARY}; "
            f"  border: none; border-radius: {T.RADIUS['md']}px; font-size: 14px; }}"
            f"QPushButton:hover {{ background: {T.BG_ELEVATED}; color: {T.TEXT_PRIMARY}; }}"
        )
