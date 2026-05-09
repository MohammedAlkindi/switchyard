from __future__ import annotations

import logging
import sys

from PyQt5.QtWidgets import (
    QWidget, QVBoxLayout, QHBoxLayout, QLabel, QPushButton, QFrame,
)
from PyQt5.QtCore import Qt, pyqtSignal, QTimer, QPropertyAnimation, QEasingCurve
from PyQt5.QtGui import QFont

import ui.theme as T
from ui.strings import (
    APP_NAME, APP_TAGLINE,
    NAV_CHAT, NAV_ANALYTICS, NAV_DOCS, NAV_PLUGINS, NAV_SETTINGS,
    STATUS_CONNECTED, STATUS_DISCONNECTED, APP_VERSION,
)
from ui.components.conversation_list import ConversationList

log = logging.getLogger("CortexAI")

_NAV_DEFS = [
    ("chat",      "◻", NAV_CHAT),
    ("analytics", "◎", NAV_ANALYTICS),
    ("docs",      "≡", NAV_DOCS),
    ("plugins",   "⊞", NAV_PLUGINS),
    ("settings",  "⚙", NAV_SETTINGS),
]

WIDTH = 260


class Sidebar(QWidget):
    """Full sidebar: logo, conversation history, navigation, status."""

    nav_changed            = pyqtSignal(str)
    new_chat_requested     = pyqtSignal()
    conversation_selected  = pyqtSignal(str)
    conversation_deleted   = pyqtSignal(str)
    conversation_renamed   = pyqtSignal(str, str)

    def __init__(self, parent=None):
        super().__init__(parent)
        self.setFixedWidth(WIDTH)
        self.setAttribute(Qt.WA_StyledBackground, True)
        self.setStyleSheet(f"background: {T.BG_SURFACE};")

        self._current_nav = "chat"
        self._nav_items: dict[str, "_NavItem"] = {}
        self._connected  = False
        self._model_name = ""

        v = QVBoxLayout(self)
        v.setContentsMargins(0, 0, 0, 0)
        v.setSpacing(0)

        v.addWidget(self._build_header())
        v.addWidget(_divider())

        # Conversation list takes most vertical space
        self._conv_list = ConversationList()
        self._conv_list.new_chat_requested.connect(self.new_chat_requested)
        self._conv_list.conversation_selected.connect(self.conversation_selected)
        self._conv_list.conversation_deleted.connect(self.conversation_deleted)
        self._conv_list.conversation_renamed.connect(self.conversation_renamed)
        v.addWidget(self._conv_list, 1)

        v.addWidget(_divider())
        v.addWidget(self._build_nav())
        v.addStretch()
        v.addWidget(_divider())
        v.addWidget(self._build_status())

        self._nav_items["chat"].set_active(True)

    # ── Sub-builders ──────────────────────────────────────────────────────────

    def _build_header(self) -> QWidget:
        w = QWidget()
        w.setFixedHeight(56)
        w.setAttribute(Qt.WA_StyledBackground, True)
        w.setStyleSheet(f"background: {T.BG_SURFACE};")

        row = QHBoxLayout(w)
        row.setContentsMargins(T.SPACING["lg"], 0, T.SPACING["md"], 0)
        row.setSpacing(T.SPACING["sm"])

        logo = QLabel("C")
        logo.setFixedSize(32, 32)
        logo.setAlignment(Qt.AlignCenter)
        logo.setStyleSheet(
            f"background: {T.BRAND_PRIMARY}; color: {T.TEXT_ON_BRAND}; "
            f"border-radius: {T.RADIUS['lg']}px; font-size: 14px; font-weight: 700;"
        )
        row.addWidget(logo)

        col = QVBoxLayout()
        col.setSpacing(1)
        name = QLabel(APP_NAME)
        name.setFont(QFont(T.FONT_FAMILY, T.FONT_SIZES["md"], T.FONT_WEIGHTS["semibold"]))
        name.setStyleSheet(f"color: {T.TEXT_PRIMARY}; background: transparent;")
        tagline = QLabel(APP_TAGLINE)
        tagline.setFont(QFont(T.FONT_FAMILY, T.FONT_SIZES["xs"]))
        tagline.setStyleSheet(f"color: {T.TEXT_TERTIARY}; background: transparent;")
        col.addWidget(name)
        col.addWidget(tagline)
        row.addLayout(col)
        row.addStretch()

        new_btn = QPushButton("+")
        new_btn.setFixedSize(28, 28)
        new_btn.setToolTip("New conversation (Ctrl+N)")
        new_btn.setCursor(Qt.PointingHandCursor)
        new_btn.setStyleSheet(
            f"QPushButton {{ background: {T.BG_ELEVATED}; color: {T.TEXT_SECONDARY}; "
            f"  border: none; border-radius: {T.RADIUS['md']}px; font-size: 16px; }}"
            f"QPushButton:hover {{ color: {T.BRAND_PRIMARY}; }}"
        )
        new_btn.clicked.connect(self.new_chat_requested)
        row.addWidget(new_btn)
        return w

    def _build_nav(self) -> QWidget:
        w = QWidget()
        w.setAttribute(Qt.WA_StyledBackground, True)
        w.setStyleSheet("background: transparent;")
        v = QVBoxLayout(w)
        v.setContentsMargins(T.SPACING["sm"], T.SPACING["sm"], T.SPACING["sm"], T.SPACING["sm"])
        v.setSpacing(2)

        for key, icon, label in _NAV_DEFS:
            item = _NavItem(icon, label, key)
            item.clicked.connect(self._on_nav_clicked)
            self._nav_items[key] = item
            v.addWidget(item)
        return w

    def _build_status(self) -> QWidget:
        w = QWidget()
        w.setFixedHeight(36)
        w.setAttribute(Qt.WA_StyledBackground, True)
        w.setStyleSheet("background: transparent;")

        row = QHBoxLayout(w)
        row.setContentsMargins(T.SPACING["lg"], 0, T.SPACING["lg"], 0)
        row.setSpacing(T.SPACING["sm"])

        self._status_dot = QLabel("●")
        self._status_dot.setFixedWidth(10)
        self._status_dot.setStyleSheet(f"color: {T.TEXT_TERTIARY}; font-size: 8px;")
        row.addWidget(self._status_dot)

        self._status_lbl = QLabel(STATUS_DISCONNECTED)
        self._status_lbl.setFont(QFont(T.FONT_FAMILY, T.FONT_SIZES["xs"]))
        self._status_lbl.setStyleSheet(f"color: {T.TEXT_TERTIARY}; background: transparent;")
        row.addWidget(self._status_lbl)
        row.addStretch()

        ver = QLabel(f"v{APP_VERSION}")
        ver.setFont(QFont(T.FONT_FAMILY, T.FONT_SIZES["xs"]))
        ver.setStyleSheet(f"color: {T.TEXT_TERTIARY}; background: transparent;")
        row.addWidget(ver)
        return w

    # ── Public API ────────────────────────────────────────────────────────────

    def set_key_status(self, ok: bool) -> None:
        self._connected = ok
        color = T.SUCCESS if ok else T.TEXT_TERTIARY
        self._status_dot.setStyleSheet(f"color: {color}; font-size: 8px;")
        model = f" · {self._model_name}" if self._model_name else ""
        self._status_lbl.setText(
            (STATUS_CONNECTED + model) if ok else STATUS_DISCONNECTED
        )

    def set_model_name(self, name: str) -> None:
        self._model_name = name
        self.set_key_status(self._connected)

    def load_conversations(self, conversations: list) -> None:
        self._conv_list.load_conversations(conversations)

    def add_or_update_conversation(self, conv: dict) -> None:
        self._conv_list.add_or_update(conv)

    def set_active_conversation(self, cid: str) -> None:
        self._conv_list.set_active(cid)

    def set_active_nav(self, key: str) -> None:
        if self._current_nav and self._current_nav in self._nav_items:
            self._nav_items[self._current_nav].set_active(False)
        self._current_nav = key
        if key in self._nav_items:
            self._nav_items[key].set_active(True)

    def reset(self):
        pass

    # ── Slots ─────────────────────────────────────────────────────────────────

    def _on_nav_clicked(self, key: str) -> None:
        if key == self._current_nav:
            return
        self.set_active_nav(key)
        self.nav_changed.emit(key)


class _NavItem(QWidget):
    clicked = pyqtSignal(str)

    def __init__(self, icon: str, label: str, key: str, parent=None):
        super().__init__(parent)
        self._key    = key
        self._active = False
        self.setFixedHeight(36)
        self.setCursor(Qt.PointingHandCursor)
        self.setAttribute(Qt.WA_StyledBackground, True)

        row = QHBoxLayout(self)
        row.setContentsMargins(T.SPACING["md"], 0, T.SPACING["md"], 0)
        row.setSpacing(T.SPACING["md"] - 2)

        self._icon = QLabel(icon)
        self._icon.setFixedWidth(18)
        self._icon.setAlignment(Qt.AlignCenter)
        self._icon.setStyleSheet(f"color: {T.TEXT_TERTIARY}; background: transparent; font-size: 14px;")
        row.addWidget(self._icon)

        self._label = QLabel(label)
        self._label.setFont(QFont(T.FONT_FAMILY, T.FONT_SIZES["base"]))
        self._label.setStyleSheet(f"color: {T.TEXT_SECONDARY}; background: transparent;")
        row.addWidget(self._label)
        row.addStretch()

        self._refresh()

    def set_active(self, active: bool) -> None:
        self._active = active
        self._refresh()

    def _refresh(self) -> None:
        if self._active:
            self.setStyleSheet(
                f"background: {T.BG_ELEVATED}; border-radius: {T.RADIUS['md']}px;"
            )
            self._icon.setStyleSheet(f"color: {T.BRAND_PRIMARY}; background: transparent; font-size: 14px;")
            self._label.setStyleSheet(f"color: {T.TEXT_PRIMARY}; background: transparent;")
        else:
            self.setStyleSheet("background: transparent; border-radius: 0;")
            self._icon.setStyleSheet(f"color: {T.TEXT_TERTIARY}; background: transparent; font-size: 14px;")
            self._label.setStyleSheet(f"color: {T.TEXT_SECONDARY}; background: transparent;")

    def enterEvent(self, _e):
        if not self._active:
            self.setStyleSheet(f"background: {T.BG_OVERLAY}; border-radius: {T.RADIUS['md']}px;")
            self._label.setStyleSheet(f"color: {T.TEXT_PRIMARY}; background: transparent;")

    def leaveEvent(self, _e):
        if not self._active:
            self._refresh()

    def mousePressEvent(self, event):
        if event.button() == Qt.LeftButton:
            self.clicked.emit(self._key)


def _divider() -> QFrame:
    f = QFrame()
    f.setFrameShape(QFrame.HLine)
    f.setStyleSheet(f"border: none; border-top: 1px solid {T.BG_BORDER};")
    f.setFixedHeight(1)
    return f
