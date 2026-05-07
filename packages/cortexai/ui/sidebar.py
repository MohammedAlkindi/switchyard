import logging
import os
import sys

from PyQt5.QtWidgets import (
    QWidget, QVBoxLayout, QHBoxLayout, QLabel, QLineEdit, QComboBox,
    QCheckBox, QFrame,
)
from PyQt5.QtCore import pyqtSignal, Qt

log = logging.getLogger("CortexAI")

_NAV_ITEMS = [
    ("chat",      "●", "Chat"),
    ("analytics", "●", "Analytics"),
    ("docs",      "●", "Docs"),
]

_COMBO_STYLE = (
    "QComboBox { background:#161616; border:1px solid #252525; border-radius:5px; "
    "            padding:4px 8px; color:#E2E2E2; font-size:12px; }"
    "QComboBox:hover { border-color:#333; }"
    "QComboBox:focus { border-color:#5E6AD2; }"
    "QComboBox::drop-down { border:none; width:18px; }"
    "QComboBox QAbstractItemView { background:#1A1A1A; border:1px solid #252525; "
    "    selection-background-color:#5E6AD2; color:#E2E2E2; outline:none; }"
)
_INPUT_STYLE = (
    "QLineEdit { background:#161616; border:1px solid #252525; border-radius:5px; "
    "            padding:4px 8px; color:#E2E2E2; font-size:12px; }"
    "QLineEdit:hover { border-color:#333; }"
    "QLineEdit:focus { border-color:#5E6AD2; }"
)
_CHECK_STYLE = (
    "QCheckBox { color:#666; font-size:12px; spacing:8px; background:transparent; }"
    "QCheckBox:hover { color:#CCC; }"
    "QCheckBox::indicator { width:13px; height:13px; border:1px solid #333; "
    "    border-radius:3px; background:#161616; }"
    "QCheckBox::indicator:checked { background:#5E6AD2; border-color:#5E6AD2; }"
)


def _divider() -> QFrame:
    line = QFrame()
    line.setFrameShape(QFrame.HLine)
    line.setFrameShadow(QFrame.Plain)
    line.setStyleSheet("border:none; border-top:1px solid #1C1C1C; margin:0;")
    line.setFixedHeight(1)
    return line


class NavItem(QWidget):
    clicked = pyqtSignal(str)

    def __init__(self, icon: str, text: str, key: str, parent=None):
        super().__init__(parent)
        self._key = key
        self._active = False
        self._hovered = False
        self.setCursor(Qt.PointingHandCursor)
        self.setFixedHeight(32)
        self.setAttribute(Qt.WA_StyledBackground, True)

        row = QHBoxLayout(self)
        row.setContentsMargins(16, 0, 12, 0)
        row.setSpacing(9)

        self._icon_lbl = QLabel(icon)
        self._icon_lbl.setFixedWidth(10)
        self._icon_lbl.setAttribute(Qt.WA_TransparentForMouseEvents, True)

        self._text_lbl = QLabel(text)
        self._text_lbl.setAttribute(Qt.WA_TransparentForMouseEvents, True)

        row.addWidget(self._icon_lbl)
        row.addWidget(self._text_lbl)
        row.addStretch()

        self._refresh()

    def set_active(self, active: bool):
        self._active = active
        self._refresh()

    def _refresh(self):
        if self._active:
            self.setStyleSheet("background:#1C1A2E; border-left:2px solid #5E6AD2;")
            self._icon_lbl.setStyleSheet(
                "color:#5E6AD2; font-size:7px; background:transparent;"
            )
            self._text_lbl.setStyleSheet(
                "color:#E2E2E2; font-size:13px; font-weight:500; background:transparent;"
            )
        elif self._hovered:
            self.setStyleSheet("background:#191919; border-left:2px solid transparent;")
            self._icon_lbl.setStyleSheet(
                "color:#666; font-size:7px; background:transparent;"
            )
            self._text_lbl.setStyleSheet(
                "color:#CCCCCC; font-size:13px; background:transparent;"
            )
        else:
            self.setStyleSheet("background:transparent; border-left:2px solid transparent;")
            self._icon_lbl.setStyleSheet(
                "color:#383838; font-size:7px; background:transparent;"
            )
            self._text_lbl.setStyleSheet(
                "color:#7A7A7A; font-size:13px; background:transparent;"
            )

    def enterEvent(self, _event):
        self._hovered = True
        if not self._active:
            self._refresh()

    def leaveEvent(self, _event):
        self._hovered = False
        if not self._active:
            self._refresh()

    def mousePressEvent(self, event):
        if event.button() == Qt.LeftButton:
            self.clicked.emit(self._key)


class Sidebar(QWidget):
    model_changed   = pyqtSignal(str)
    mode_changed    = pyqtSignal(str)
    api_key_changed = pyqtSignal(str)
    nav_changed     = pyqtSignal(str)

    def __init__(self, parent=None):
        super().__init__(parent)
        self.setFixedWidth(224)
        self.setAttribute(Qt.WA_StyledBackground, True)
        self.setStyleSheet("background:#111111;")

        layout = QVBoxLayout(self)
        layout.setContentsMargins(0, 0, 0, 0)
        layout.setSpacing(0)

        layout.addWidget(self._build_header())
        layout.addSpacing(6)
        layout.addWidget(self._section_label("NAVIGATE"))
        self._nav_items: dict = {}
        for key, icon, text in _NAV_ITEMS:
            item = NavItem(icon, text, key)
            item.clicked.connect(self._on_nav_clicked)
            self._nav_items[key] = item
            layout.addWidget(item)

        self._current_nav = "chat"
        self._nav_items["chat"].set_active(True)

        layout.addSpacing(10)
        layout.addWidget(_divider())
        layout.addSpacing(6)
        layout.addWidget(self._section_label("SETTINGS"))
        layout.addWidget(self._build_settings())

        layout.addSpacing(8)
        layout.addWidget(_divider())
        layout.addSpacing(6)
        layout.addWidget(self._section_label("FEATURES"))
        layout.addWidget(self._build_features())

        layout.addStretch()
        layout.addWidget(_divider())
        layout.addWidget(self._build_footer())

    # ── Sub-builders ──────────────────────────────────────────────────────

    def _build_header(self) -> QWidget:
        header = QWidget()
        header.setFixedHeight(52)
        header.setAttribute(Qt.WA_StyledBackground, True)
        header.setStyleSheet("background:#111111; border-bottom:1px solid #1C1C1C;")
        row = QHBoxLayout(header)
        row.setContentsMargins(14, 0, 14, 0)
        row.setSpacing(10)

        logo = QLabel("C")
        logo.setFixedSize(26, 26)
        logo.setAlignment(Qt.AlignCenter)
        logo.setStyleSheet(
            "background:#5E6AD2; color:white; border-radius:6px; "
            "font-size:13px; font-weight:700;"
        )

        name = QLabel("CortexAI")
        name.setStyleSheet(
            "color:#E2E2E2; font-size:14px; font-weight:600; "
            "letter-spacing:0.2px; background:transparent;"
        )

        row.addWidget(logo)
        row.addWidget(name)
        row.addStretch()
        return header

    def _build_settings(self) -> QWidget:
        w = QWidget()
        w.setAttribute(Qt.WA_StyledBackground, True)
        w.setStyleSheet("background:transparent;")
        sl = QVBoxLayout(w)
        sl.setContentsMargins(12, 0, 12, 0)
        sl.setSpacing(5)

        api_lbl = QLabel("Anthropic API Key")
        api_lbl.setStyleSheet("color:#484848; font-size:11px; background:transparent;")
        sl.addWidget(api_lbl)

        self._api_key_input = QLineEdit()
        self._api_key_input.setPlaceholderText("sk-ant-…")
        self._api_key_input.setEchoMode(QLineEdit.Password)
        self._api_key_input.setStyleSheet(_INPUT_STYLE)
        env_key = os.environ.get("ANTHROPIC_API_KEY", "")
        if env_key:
            self._api_key_input.setText(env_key)
        self._api_key_input.editingFinished.connect(
            lambda: self.api_key_changed.emit(self._api_key_input.text().strip())
        )
        sl.addWidget(self._api_key_input)

        self._key_status = QLabel(
            "● Key loaded" if env_key else "○ No key set"
        )
        status_color = "#26B5A7" if env_key else "#484848"
        self._key_status.setStyleSheet(
            f"color:{status_color}; font-size:11px; background:transparent;"
        )
        sl.addWidget(self._key_status)

        sl.addSpacing(6)
        model_lbl = QLabel("Model")
        model_lbl.setStyleSheet("color:#484848; font-size:11px; background:transparent;")
        sl.addWidget(model_lbl)

        self._model_combo = QComboBox()
        self._model_combo.addItems([
            "Smart Routing (Auto)",
            "OpenAI GPT-4",
            "Anthropic Claude",
            "Self-Hosted Llama",
            "Hybrid Ensemble",
        ])
        self._model_combo.setStyleSheet(_COMBO_STYLE)
        self._model_combo.currentTextChanged.connect(self.model_changed)
        sl.addWidget(self._model_combo)

        sl.addSpacing(6)
        perf_lbl = QLabel("Performance")
        perf_lbl.setStyleSheet("color:#484848; font-size:11px; background:transparent;")
        sl.addWidget(perf_lbl)

        self._mode_combo = QComboBox()
        self._mode_combo.addItems(["Balanced", "Speed", "Quality", "Extreme"])
        self._mode_combo.setStyleSheet(_COMBO_STYLE)
        self._mode_combo.currentTextChanged.connect(self.mode_changed)
        sl.addWidget(self._mode_combo)

        return w

    def _build_features(self) -> QWidget:
        w = QWidget()
        w.setAttribute(Qt.WA_StyledBackground, True)
        w.setStyleSheet("background:transparent;")
        fl = QVBoxLayout(w)
        fl.setContentsMargins(12, 0, 12, 0)
        fl.setSpacing(4)

        self._toggles = {
            "legal":    QCheckBox("Legal Review"),
            "privacy":  QCheckBox("Enterprise Privacy"),
            "memory":   QCheckBox("Conversation Memory"),
            "analytics": QCheckBox("Analytics"),
        }
        for cb in self._toggles.values():
            cb.setStyleSheet(_CHECK_STYLE)
            fl.addWidget(cb)

        return w

    def _build_footer(self) -> QWidget:
        footer = QWidget()
        footer.setAttribute(Qt.WA_StyledBackground, True)
        footer.setStyleSheet("background:#111111;")
        row = QHBoxLayout(footer)
        row.setContentsMargins(14, 8, 14, 10)
        lbl = QLabel(f"v1.0  ·  Python {sys.version.split()[0]}")
        lbl.setStyleSheet("color:#2E2E2E; font-size:10px; background:transparent;")
        row.addWidget(lbl)
        row.addStretch()
        return footer

    def _section_label(self, text: str) -> QLabel:
        lbl = QLabel(text)
        lbl.setStyleSheet(
            "color:#303030; font-size:10px; font-weight:700; letter-spacing:0.9px; "
            "padding:0 14px 4px 14px; background:transparent;"
        )
        return lbl

    # ── Slots ─────────────────────────────────────────────────────────────

    def _on_nav_clicked(self, key: str):
        if key == self._current_nav:
            return
        self._nav_items[self._current_nav].set_active(False)
        self._current_nav = key
        self._nav_items[key].set_active(True)
        self.nav_changed.emit(key)

    def set_key_status(self, ok: bool):
        if ok:
            self._key_status.setText("● Connected")
            self._key_status.setStyleSheet("color:#26B5A7; font-size:11px; background:transparent;")
        else:
            self._key_status.setText("● Invalid key")
            self._key_status.setStyleSheet("color:#D95252; font-size:11px; background:transparent;")
