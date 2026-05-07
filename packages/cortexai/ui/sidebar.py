import logging
import os
import sys

from PyQt5.QtWidgets import (
    QWidget, QVBoxLayout, QLabel, QLineEdit, QComboBox, QCheckBox,
)
from PyQt5.QtCore import pyqtSignal

log = logging.getLogger("CortexAI")


class Sidebar(QWidget):
    model_changed = pyqtSignal(str)
    mode_changed = pyqtSignal(str)
    api_key_changed = pyqtSignal(str)

    def __init__(self, parent=None):
        super().__init__(parent)
        self.setFixedWidth(220)
        self.setStyleSheet("background:#252526; color:#d4d4d4;")
        layout = QVBoxLayout(self)
        layout.setContentsMargins(10, 10, 10, 10)
        layout.setSpacing(12)

        layout.addWidget(self._section_label("ANTHROPIC API KEY"))
        self._api_key_input = QLineEdit()
        self._api_key_input.setPlaceholderText("sk-ant-…")
        self._api_key_input.setEchoMode(QLineEdit.Password)
        self._api_key_input.setStyleSheet(
            "background:#1e1e1e; color:#d4d4d4; border:1px solid #444; "
            "border-radius:3px; padding:4px;"
        )
        env_key = os.environ.get("ANTHROPIC_API_KEY", "")
        if env_key:
            self._api_key_input.setText(env_key)
        self._api_key_input.editingFinished.connect(
            lambda: self.api_key_changed.emit(self._api_key_input.text().strip())
        )
        layout.addWidget(self._api_key_input)

        self._key_status = QLabel("⚪ No key set" if not env_key else "🟢 Key loaded from env")
        self._key_status.setStyleSheet("color:#888; font-size:10px;")
        self._key_status.setWordWrap(True)
        layout.addWidget(self._key_status)

        layout.addWidget(self._section_label("MODEL"))
        self._model_combo = QComboBox()
        self._model_combo.addItems([
            "Smart Routing (Auto)",
            "OpenAI GPT-4",
            "Anthropic Claude",
            "Self-Hosted Llama",
            "Hybrid Ensemble",
        ])
        self._model_combo.currentTextChanged.connect(self.model_changed)
        layout.addWidget(self._model_combo)

        layout.addWidget(self._section_label("PERFORMANCE"))
        self._mode_combo = QComboBox()
        self._mode_combo.addItems(["Balanced", "Speed", "Quality", "Extreme"])
        self._mode_combo.currentTextChanged.connect(self.mode_changed)
        layout.addWidget(self._mode_combo)

        layout.addWidget(self._section_label("FEATURES"))
        self._toggles = {
            "legal": QCheckBox("Legal Review"),
            "privacy": QCheckBox("Enterprise Privacy"),
            "memory": QCheckBox("Conversation Memory"),
            "analytics": QCheckBox("Analytics"),
        }
        for cb in self._toggles.values():
            layout.addWidget(cb)

        layout.addStretch()
        layout.addWidget(QLabel(f"v1.0 | Python {sys.version.split()[0]}"))

    def _section_label(self, text: str) -> QLabel:
        lbl = QLabel(text)
        lbl.setStyleSheet("color:#888; font-size:10px; font-weight:bold; margin-top:8px;")
        return lbl

    def set_key_status(self, ok: bool):
        if ok:
            self._key_status.setText("🟢 Connected")
            self._key_status.setStyleSheet("color:#4CAF50; font-size:10px;")
        else:
            self._key_status.setText("🔴 Invalid key")
            self._key_status.setStyleSheet("color:#f44336; font-size:10px;")
