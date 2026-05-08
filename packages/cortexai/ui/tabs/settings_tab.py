from __future__ import annotations

import csv
import json
import logging
import os
import platform
import sys
from pathlib import Path

from PyQt5.QtWidgets import (
    QWidget, QVBoxLayout, QHBoxLayout, QLabel, QLineEdit, QPushButton,
    QScrollArea, QSlider, QCheckBox, QPlainTextEdit, QComboBox,
    QFileDialog, QMessageBox, QFrame,
)
from PyQt5.QtCore import Qt, pyqtSignal
from PyQt5.QtGui import QFont

from core.user_settings import load_user_settings, save_user_settings
import ui.theme as T
from ui.strings import (
    SETTINGS_API_KEYS, SETTINGS_MODELS, SETTINGS_FEATURES,
    SETTINGS_APPEARANCE, SETTINGS_DATA, SETTINGS_ABOUT,
    API_KEY_PLACEHOLDER_ANT, API_KEY_PLACEHOLDER_OAI,
    API_KEY_SAVED_TOAST, API_KEY_INVALID_TOAST,
    SETTINGS_TEST_CONNECTION, SETTINGS_SAVE,
    APP_VERSION, APP_NAME,
)
from ui.components.toast import show_toast

log = logging.getLogger("CortexAI")

_SUB_NAVS = [
    SETTINGS_API_KEYS,
    SETTINGS_MODELS,
    SETTINGS_FEATURES,
    SETTINGS_APPEARANCE,
    SETTINGS_DATA,
    SETTINGS_ABOUT,
]


class SettingsTab(QWidget):
    """Full settings page with sub-navigation."""

    api_key_changed       = pyqtSignal(str)
    model_changed         = pyqtSignal(str)
    conversations_cleared = pyqtSignal()
    settings_changed      = pyqtSignal(dict)

    def __init__(self, ai_core, parent=None):
        super().__init__(parent)
        self._ai_core = ai_core
        self._conv_store = None
        self._setup_ui()

    def set_conversation_store(self, store):
        self._conv_store = store
        self._panel_data.set_conversation_store(store)

    def _setup_ui(self):
        self.setStyleSheet(f"background: {T.BG_BASE};")
        root = QHBoxLayout(self)
        root.setContentsMargins(0, 0, 0, 0)
        root.setSpacing(0)

        # Left sub-nav
        nav_panel = QWidget()
        nav_panel.setFixedWidth(200)
        nav_panel.setAttribute(Qt.WA_StyledBackground, True)
        nav_panel.setStyleSheet(
            f"background: {T.BG_SURFACE}; border-right: 1px solid {T.BG_BORDER};"
        )
        nav_v = QVBoxLayout(nav_panel)
        nav_v.setContentsMargins(0, T.SPACING["xl"], 0, T.SPACING["xl"])
        nav_v.setSpacing(2)

        hdr = QLabel("Settings")
        hdr.setFont(QFont(T.FONT_FAMILY, T.FONT_SIZES["lg"], T.FONT_WEIGHTS["semibold"]))
        hdr.setStyleSheet(
            f"color: {T.TEXT_PRIMARY}; background: transparent; "
            f"padding: 0 {T.SPACING['lg']}px {T.SPACING['lg']}px {T.SPACING['lg']}px;"
        )
        nav_v.addWidget(hdr)

        self._nav_items: dict[str, _SubNavItem] = {}
        for label in _SUB_NAVS:
            item = _SubNavItem(label)
            item.clicked.connect(self._on_nav_clicked)
            self._nav_items[label] = item
            nav_v.addWidget(item)
        nav_v.addStretch()
        root.addWidget(nav_panel)

        from PyQt5.QtWidgets import QStackedWidget
        self._stack = QStackedWidget()
        self._stack.setStyleSheet(f"background: {T.BG_BASE};")

        self._panel_api      = _ApiKeysPanel(self._ai_core)
        self._panel_api.api_key_changed.connect(self.api_key_changed)
        self._panel_models   = _ModelsPanel()
        self._panel_models.settings_changed.connect(self.settings_changed)
        self._panel_features = _FeaturesPanel()
        self._panel_appear   = _AppearancePanel()
        self._panel_appear.settings_changed.connect(self.settings_changed)
        self._panel_data     = _DataPanel(self._ai_core)
        self._panel_data.conversations_cleared.connect(self.conversations_cleared)
        self._panel_about    = _AboutPanel()

        for p in (self._panel_api, self._panel_models, self._panel_features,
                  self._panel_appear, self._panel_data, self._panel_about):
            self._stack.addWidget(p)

        root.addWidget(self._stack, 1)

        self._current = SETTINGS_API_KEYS
        self._nav_items[SETTINGS_API_KEYS].set_active(True)

    def _on_nav_clicked(self, label: str):
        if self._current == label:
            return
        self._nav_items[self._current].set_active(False)
        self._current = label
        self._nav_items[label].set_active(True)
        idx = _SUB_NAVS.index(label)
        self._stack.setCurrentIndex(idx)

    def reset(self):
        pass


# ── Sub-nav item ──────────────────────────────────────────────────────────────

class _SubNavItem(QWidget):
    clicked = pyqtSignal(str)

    def __init__(self, label: str, parent=None):
        super().__init__(parent)
        self._label = label
        self._active = False
        self.setFixedHeight(36)
        self.setCursor(Qt.PointingHandCursor)
        self.setAttribute(Qt.WA_StyledBackground, True)

        row = QHBoxLayout(self)
        row.setContentsMargins(T.SPACING["lg"], 0, T.SPACING["md"], 0)
        self._lbl = QLabel(label)
        self._lbl.setFont(QFont(T.FONT_FAMILY, T.FONT_SIZES["base"]))
        self._lbl.setStyleSheet(f"color: {T.TEXT_SECONDARY}; background: transparent;")
        row.addWidget(self._lbl)
        self._refresh()

    def set_active(self, active: bool):
        self._active = active
        self._refresh()

    def _refresh(self):
        if self._active:
            self.setStyleSheet(
                f"background: {T.BG_ELEVATED}; border-left: 2px solid {T.BRAND_PRIMARY}; "
                f"border-radius: {T.RADIUS['sm']}px;"
            )
            self._lbl.setStyleSheet(f"color: {T.TEXT_PRIMARY}; background: transparent;")
        else:
            self.setStyleSheet(
                "background: transparent; border-left: 2px solid transparent; "
                f"border-radius: {T.RADIUS['sm']}px;"
            )
            self._lbl.setStyleSheet(f"color: {T.TEXT_SECONDARY}; background: transparent;")

    def enterEvent(self, _e):
        if not self._active:
            self.setStyleSheet(
                f"background: {T.BG_OVERLAY}; border-left: 2px solid transparent; "
                f"border-radius: {T.RADIUS['sm']}px;"
            )
            self._lbl.setStyleSheet(f"color: {T.TEXT_PRIMARY}; background: transparent;")

    def leaveEvent(self, _e):
        if not self._active:
            self._refresh()

    def mousePressEvent(self, e):
        if e.button() == Qt.LeftButton:
            self.clicked.emit(self._label)


# ── Panels ────────────────────────────────────────────────────────────────────

def _scroll_panel() -> tuple:
    outer = QScrollArea()
    outer.setWidgetResizable(True)
    outer.setStyleSheet(f"QScrollArea {{ border: none; background: {T.BG_BASE}; }}")
    inner = QWidget()
    inner.setStyleSheet("background: transparent;")
    v = QVBoxLayout(inner)
    v.setContentsMargins(T.SPACING["3xl"], T.SPACING["2xl"], T.SPACING["3xl"], T.SPACING["2xl"])
    v.setSpacing(T.SPACING["2xl"])
    outer.setWidget(inner)
    return outer, v


def _section(v: QVBoxLayout, title: str):
    lbl = QLabel(title)
    lbl.setFont(QFont(T.FONT_FAMILY, T.FONT_SIZES["lg"], T.FONT_WEIGHTS["semibold"]))
    lbl.setStyleSheet(f"color: {T.TEXT_PRIMARY}; background: transparent;")
    v.addWidget(lbl)
    sep = QFrame()
    sep.setFrameShape(QFrame.HLine)
    sep.setStyleSheet(f"border: none; border-top: 1px solid {T.BG_BORDER};")
    sep.setFixedHeight(1)
    v.addWidget(sep)


def _field_label(text: str) -> QLabel:
    lbl = QLabel(text)
    lbl.setFont(QFont(T.FONT_FAMILY, T.FONT_SIZES["sm"]))
    lbl.setStyleSheet(f"color: {T.TEXT_SECONDARY}; background: transparent;")
    return lbl


def _primary_btn(text: str, w: int = 0) -> QPushButton:
    btn = QPushButton(text)
    if w:
        btn.setFixedWidth(w)
    btn.setFixedHeight(36)
    btn.setCursor(Qt.PointingHandCursor)
    btn.setFont(QFont(T.FONT_FAMILY, T.FONT_SIZES["base"], T.FONT_WEIGHTS["medium"]))
    btn.setStyleSheet(
        f"QPushButton {{ background: {T.BRAND_PRIMARY}; color: {T.TEXT_ON_BRAND}; "
        f"  border: none; border-radius: {T.RADIUS['md']}px; padding: 0 {T.SPACING['lg']}px; }}"
        f"QPushButton:hover {{ background: {T.BRAND_HOVER}; }}"
    )
    return btn


def _ghost_btn(text: str, w: int = 0) -> QPushButton:
    btn = QPushButton(text)
    if w:
        btn.setFixedWidth(w)
    btn.setFixedHeight(34)
    btn.setCursor(Qt.PointingHandCursor)
    btn.setFont(QFont(T.FONT_FAMILY, T.FONT_SIZES["base"]))
    btn.setStyleSheet(
        f"QPushButton {{ background: transparent; color: {T.TEXT_SECONDARY}; "
        f"  border: 1px solid {T.BG_BORDER}; border-radius: {T.RADIUS['md']}px; "
        f"  padding: 0 {T.SPACING['lg']}px; }}"
        f"QPushButton:hover {{ color: {T.TEXT_PRIMARY}; border-color: {T.BG_OVERLAY}; }}"
    )
    return btn


class _ApiKeysPanel(QWidget):
    api_key_changed = pyqtSignal(str)

    def __init__(self, ai_core, parent=None):
        super().__init__(parent)
        self._ai_core = ai_core
        outer, v = _scroll_panel()
        root = QVBoxLayout(self)
        root.setContentsMargins(0, 0, 0, 0)
        root.addWidget(outer)

        _section(v, SETTINGS_API_KEYS)

        v.addWidget(_field_label("Anthropic API Key"))
        ant_row = QHBoxLayout()
        self._ant_input = QLineEdit()
        self._ant_input.setEchoMode(QLineEdit.Password)
        self._ant_input.setPlaceholderText(API_KEY_PLACEHOLDER_ANT)
        env_key = os.environ.get("ANTHROPIC_API_KEY", "")
        if env_key:
            self._ant_input.setText(env_key)
        ant_row.addWidget(self._ant_input, 1)

        show_ant = _ghost_btn("👁", 36)
        show_ant.clicked.connect(lambda: self._toggle_echo(self._ant_input))
        ant_row.addWidget(show_ant)

        test_ant = _ghost_btn(SETTINGS_TEST_CONNECTION)
        test_ant.clicked.connect(self._test_ant)
        ant_row.addWidget(test_ant)
        v.addLayout(ant_row)

        self._ant_status = QLabel("● Key loaded" if env_key else "○ No key set")
        self._ant_status.setFont(QFont(T.FONT_FAMILY, T.FONT_SIZES["sm"]))
        color = T.SUCCESS if env_key else T.TEXT_TERTIARY
        self._ant_status.setStyleSheet(f"color: {color}; background: transparent;")
        v.addWidget(self._ant_status)

        save_ant = _primary_btn(SETTINGS_SAVE, 120)
        save_ant.clicked.connect(self._save_ant)
        v.addWidget(save_ant)

        v.addWidget(_field_label("OpenAI API Key"))
        oai_row = QHBoxLayout()
        self._oai_input = QLineEdit()
        self._oai_input.setEchoMode(QLineEdit.Password)
        self._oai_input.setPlaceholderText(API_KEY_PLACEHOLDER_OAI)
        env_oai = os.environ.get("OPENAI_API_KEY", "")
        if env_oai:
            self._oai_input.setText(env_oai)
        oai_row.addWidget(self._oai_input, 1)
        show_oai = _ghost_btn("👁", 36)
        show_oai.clicked.connect(lambda: self._toggle_echo(self._oai_input))
        oai_row.addWidget(show_oai)
        v.addLayout(oai_row)

        v.addStretch()

    def _toggle_echo(self, field: QLineEdit):
        field.setEchoMode(
            QLineEdit.Normal if field.echoMode() == QLineEdit.Password else QLineEdit.Password
        )

    def _save_ant(self):
        key = self._ant_input.text().strip()
        self._ai_core.anthropic_client.set_api_key(key)
        ok = self._ai_core.anthropic_client.ready
        color = T.SUCCESS if ok else T.ERROR
        self._ant_status.setText("● Connected" if ok else "○ Invalid / empty key")
        self._ant_status.setStyleSheet(f"color: {color}; background: transparent;")
        self.api_key_changed.emit(key)
        if ok and key:
            existing = load_user_settings()
            existing["anthropic_api_key"] = key
            save_user_settings(existing)
        show_toast(API_KEY_SAVED_TOAST if ok else API_KEY_INVALID_TOAST,
                   "success" if ok else "error", self)

    def _test_ant(self):
        key = self._ant_input.text().strip()
        self._ai_core.anthropic_client.set_api_key(key)
        ok = self._ai_core.anthropic_client.ready
        msg = "● Connected" if ok else "○ Connection failed"
        color = T.SUCCESS if ok else T.ERROR
        self._ant_status.setText(msg)
        self._ant_status.setStyleSheet(f"color: {color}; background: transparent;")

    def reset(self):
        pass


class _ModelsPanel(QWidget):
    settings_changed = pyqtSignal(dict)

    def __init__(self, parent=None):
        super().__init__(parent)
        self._settings = load_user_settings()
        outer, v = _scroll_panel()
        root = QVBoxLayout(self)
        root.setContentsMargins(0, 0, 0, 0)
        root.addWidget(outer)

        _section(v, SETTINGS_MODELS)

        v.addWidget(_field_label("Default Model"))
        self._model_combo = QComboBox()
        from ui.strings import MODELS as _MODELS, DEFAULT_MODEL_ID
        for m in _MODELS:
            self._model_combo.addItem(m["label"], m["id"])
        default_idx = next(
            (i for i, m in enumerate(_MODELS) if m["id"] == self._settings.get("default_model", DEFAULT_MODEL_ID)),
            0,
        )
        self._model_combo.setCurrentIndex(default_idx)
        self._model_combo.setFixedHeight(36)
        v.addWidget(self._model_combo)

        v.addWidget(_field_label("Performance Mode"))
        perf = QComboBox()
        perf.addItems(["Balanced", "Fast", "Extreme"])
        perf.setFixedHeight(36)
        v.addWidget(perf)

        v.addWidget(_field_label("Max Tokens"))
        tok_row = QHBoxLayout()
        self._tok_slider = QSlider(Qt.Horizontal)
        self._tok_slider.setRange(256, 8192)
        self._tok_slider.setValue(self._settings.get("max_tokens", 2048))
        tok_row.addWidget(self._tok_slider)
        tok_val = self._settings.get("max_tokens", 2048)
        tok_lbl = QLabel(f"{tok_val} tokens (~{int(tok_val*0.75)} words)")
        tok_lbl.setFont(QFont(T.FONT_FAMILY, T.FONT_SIZES["sm"]))
        tok_lbl.setStyleSheet(f"color: {T.TEXT_TERTIARY}; background: transparent;")
        tok_row.addWidget(tok_lbl)
        self._tok_slider.valueChanged.connect(
            lambda val: tok_lbl.setText(f"{val} tokens (~{int(val*0.75)} words)")
        )
        v.addLayout(tok_row)

        v.addWidget(_field_label("Temperature"))
        temp_row = QHBoxLayout()
        self._temp_slider = QSlider(Qt.Horizontal)
        self._temp_slider.setRange(0, 100)
        self._temp_slider.setValue(int(self._settings.get("temperature", 0.7) * 100))
        temp_row.addWidget(self._temp_slider)
        temp_init = self._settings.get("temperature", 0.7)
        temp_desc = "Precise" if temp_init < 0.3 else ("Creative" if temp_init > 0.7 else "Balanced")
        temp_lbl = QLabel(f"{temp_init:.2f}  — {temp_desc}")
        temp_lbl.setFont(QFont(T.FONT_FAMILY, T.FONT_SIZES["sm"]))
        temp_lbl.setStyleSheet(f"color: {T.TEXT_TERTIARY}; background: transparent;")
        temp_row.addWidget(temp_lbl)
        def _temp_changed(val):
            t = val / 100.0
            desc = "Precise" if t < 0.3 else ("Creative" if t > 0.7 else "Balanced")
            temp_lbl.setText(f"{t:.2f}  — {desc}")
        self._temp_slider.valueChanged.connect(_temp_changed)
        v.addLayout(temp_row)

        v.addWidget(_field_label("System Prompt"))
        self._sys_prompt = QPlainTextEdit()
        self._sys_prompt.setPlaceholderText("Custom instructions prepended to every conversation…")
        self._sys_prompt.setMinimumHeight(100)
        self._sys_prompt.setPlainText(self._settings.get("system_prompt", ""))
        v.addWidget(self._sys_prompt)

        save_btn = _primary_btn(SETTINGS_SAVE, 120)
        save_btn.clicked.connect(self._save)
        v.addWidget(save_btn)

        v.addStretch()

    def _save(self):
        existing = load_user_settings()
        settings = {
            "max_tokens":    self._tok_slider.value(),
            "temperature":   self._temp_slider.value() / 100.0,
            "default_model": self._model_combo.currentData(),
            "system_prompt": self._sys_prompt.toPlainText().strip(),
            "display_name":  existing.get("display_name", ""),
            "features":      existing.get("features", {}),
        }
        save_user_settings(settings)
        self._settings = settings
        self.settings_changed.emit(settings)
        show_toast("Settings saved", "success", self)

    def reset(self):
        pass


class _FeaturesPanel(QWidget):
    def __init__(self, parent=None):
        super().__init__(parent)
        outer, v = _scroll_panel()
        root = QVBoxLayout(self)
        root.setContentsMargins(0, 0, 0, 0)
        root.addWidget(outer)

        _section(v, SETTINGS_FEATURES)

        features = [
            ("Legal Review",          "Adds legal disclaimers to responses."),
            ("Enterprise Privacy",    "Prevents logging of conversation content."),
            ("Conversation Memory",   "Persists conversations across sessions."),
            ("Analytics",             "Tracks token usage and response times."),
            ("Audit Log",             "Append-only log of all AI interactions."),
            ("Local Models",          "Enable locally-hosted model support."),
        ]

        self._feature_checkboxes: dict[str, QCheckBox] = {}
        settings = load_user_settings()
        feature_state = settings.get("features", {})
        _defaults_on = {"Conversation Memory", "Analytics", "Audit Log"}

        for name, desc in features:
            row = QHBoxLayout()
            col = QVBoxLayout()
            col.setSpacing(2)
            n = QLabel(name)
            n.setFont(QFont(T.FONT_FAMILY, T.FONT_SIZES["base"], T.FONT_WEIGHTS["medium"]))
            n.setStyleSheet(f"color: {T.TEXT_PRIMARY}; background: transparent;")
            d = QLabel(desc)
            d.setFont(QFont(T.FONT_FAMILY, T.FONT_SIZES["sm"]))
            d.setStyleSheet(f"color: {T.TEXT_TERTIARY}; background: transparent;")
            col.addWidget(n)
            col.addWidget(d)
            row.addLayout(col)
            row.addStretch()
            cb = QCheckBox()
            cb.setChecked(feature_state.get(name, name in _defaults_on))
            self._feature_checkboxes[name] = cb
            row.addWidget(cb)
            v.addLayout(row)
            sep = QFrame()
            sep.setFrameShape(QFrame.HLine)
            sep.setStyleSheet(f"border: none; border-top: 1px solid {T.BG_BORDER};")
            sep.setFixedHeight(1)
            v.addWidget(sep)

        save_btn = _primary_btn("Save Features", 140)
        save_btn.clicked.connect(self._save_features)
        v.addWidget(save_btn)

        v.addStretch()

    def _save_features(self):
        existing = load_user_settings()
        existing["features"] = {
            name: cb.isChecked()
            for name, cb in self._feature_checkboxes.items()
        }
        save_user_settings(existing)
        show_toast("Features saved", "success", self)

    def reset(self):
        pass


class _AppearancePanel(QWidget):
    settings_changed = pyqtSignal(dict)

    def __init__(self, parent=None):
        super().__init__(parent)
        outer, v = _scroll_panel()
        root = QVBoxLayout(self)
        root.setContentsMargins(0, 0, 0, 0)
        root.addWidget(outer)

        _section(v, SETTINGS_APPEARANCE)

        settings = load_user_settings()

        v.addWidget(_field_label("Theme"))
        self._theme_combo = QComboBox()
        self._theme_combo.addItems(["Dark", "Light", "System"])
        self._theme_combo.setCurrentText(settings.get("theme", "Dark"))
        self._theme_combo.setFixedHeight(36)
        v.addWidget(self._theme_combo)

        v.addWidget(_field_label("Font Size"))
        self._font_size_combo = QComboBox()
        self._font_size_combo.addItems(["Small", "Medium", "Large"])
        self._font_size_combo.setCurrentText(settings.get("font_size", "Medium"))
        self._font_size_combo.setFixedHeight(36)
        v.addWidget(self._font_size_combo)

        v.addWidget(_field_label("Message Density"))
        self._density_combo = QComboBox()
        self._density_combo.addItems(["Comfortable", "Compact"])
        self._density_combo.setCurrentText(settings.get("density", "Comfortable"))
        self._density_combo.setFixedHeight(36)
        v.addWidget(self._density_combo)

        v.addWidget(_field_label("Display Name"))
        self._name_input = QLineEdit()
        self._name_input.setPlaceholderText("Your name (shown in greetings)")
        self._name_input.setText(settings.get("display_name", ""))
        v.addWidget(self._name_input)

        save_btn = _primary_btn("Save Appearance", 160)
        save_btn.clicked.connect(self._save)
        v.addWidget(save_btn)

        v.addStretch()

    def _save(self):
        existing = load_user_settings()
        existing["display_name"] = self._name_input.text().strip()
        existing["theme"] = self._theme_combo.currentText()
        existing["font_size"] = self._font_size_combo.currentText()
        existing["density"] = self._density_combo.currentText()
        save_user_settings(existing)
        self.settings_changed.emit(existing)
        show_toast("Appearance saved", "success", self)

    def reset(self):
        pass


class _DataPanel(QWidget):
    conversations_cleared = pyqtSignal()

    def __init__(self, ai_core, parent=None):
        super().__init__(parent)
        self._ai_core = ai_core
        self._conv_store = None
        outer, v = _scroll_panel()
        root = QVBoxLayout(self)
        root.setContentsMargins(0, 0, 0, 0)
        root.addWidget(outer)

        _section(v, SETTINGS_DATA)

        export_row = QHBoxLayout()
        exp_json = _ghost_btn("Export Conversations (JSON)")
        exp_json.clicked.connect(lambda: self._export("json"))
        export_row.addWidget(exp_json)
        exp_csv = _ghost_btn("Export Conversations (CSV)")
        exp_csv.clicked.connect(lambda: self._export("csv"))
        export_row.addWidget(exp_csv)
        export_row.addStretch()
        v.addLayout(export_row)

        exp_audit = _ghost_btn("Export Audit Log")
        exp_audit.clicked.connect(self._export_audit)
        v.addWidget(exp_audit)

        clear_btn = QPushButton("Clear All Conversations")
        clear_btn.setFixedHeight(36)
        clear_btn.setCursor(Qt.PointingHandCursor)
        clear_btn.setStyleSheet(
            f"QPushButton {{ background: {T.ERROR_BG}; color: {T.ERROR}; "
            f"  border: 1px solid {T.ERROR}; border-radius: {T.RADIUS['md']}px; "
            f"  padding: 0 {T.SPACING['lg']}px; }}"
            f"QPushButton:hover {{ background: {T.ERROR}; color: {T.BG_BASE}; }}"
        )
        clear_btn.clicked.connect(self._clear_all)
        v.addWidget(clear_btn)

        v.addStretch()

    def set_conversation_store(self, store):
        self._conv_store = store

    def _export(self, fmt: str):
        path, _ = QFileDialog.getSaveFileName(
            self, "Export Conversations", "",
            "JSON Files (*.json)" if fmt == "json" else "CSV Files (*.csv)"
        )
        if not path or not self._conv_store:
            return
        convs = self._conv_store.list_recent(limit=10000)
        if not convs:
            show_toast("Nothing to export", "info", self)
            return
        try:
            if fmt == "json":
                Path(path).write_text(
                    json.dumps(convs, indent=2, ensure_ascii=False), encoding="utf-8"
                )
            else:
                with open(path, "w", newline="", encoding="utf-8") as f:
                    writer = csv.writer(f)
                    writer.writerow(["conversation_id", "title", "role", "content", "timestamp"])
                    for conv in convs:
                        for msg in conv.get("messages", []):
                            writer.writerow([
                                conv["id"], conv["title"],
                                msg["role"], msg["content"], msg.get("timestamp", "")
                            ])
            show_toast(f"Saved to {path}", "success", self)
        except Exception as e:
            show_toast(f"Export failed: {e}", "error", self)

    def _export_audit(self):
        path, _ = QFileDialog.getSaveFileName(self, "Export Audit Log", "", "JSON Files (*.json)")
        if path:
            actual_path = self._ai_core.compliance.export(path)
            show_toast(f"Audit log saved to {actual_path}", "success", self)

    def _clear_all(self):
        reply = QMessageBox.question(
            self, "Clear All",
            "Delete all conversation history? This cannot be undone.",
            QMessageBox.Yes | QMessageBox.No,
        )
        if reply == QMessageBox.Yes:
            if self._conv_store:
                for conv in self._conv_store.list_recent(limit=10000):
                    self._conv_store.delete(conv["id"])
            self.conversations_cleared.emit()
            show_toast("All conversations cleared", "info", self)

    def reset(self):
        pass


class _AboutPanel(QWidget):
    def __init__(self, parent=None):
        super().__init__(parent)
        outer, v = _scroll_panel()
        root = QVBoxLayout(self)
        root.setContentsMargins(0, 0, 0, 0)
        root.addWidget(outer)

        _section(v, SETTINGS_ABOUT)

        import PyQt5.QtCore as _qtc
        pyqt_version = _qtc.PYQT_VERSION_STR

        for row_text, val in (
            ("Version",  APP_VERSION),
            ("Python",   sys.version.split()[0]),
            ("Platform", f"{platform.system()} {platform.release()}"),
            ("PyQt5",    pyqt_version),
        ):
            row = QHBoxLayout()
            k = QLabel(row_text)
            k.setFont(QFont(T.FONT_FAMILY, T.FONT_SIZES["base"]))
            k.setStyleSheet(f"color: {T.TEXT_SECONDARY}; background: transparent;")
            row.addWidget(k)
            row.addStretch()
            val_lbl = QLabel(val)
            val_lbl.setFont(QFont(T.FONT_FAMILY, T.FONT_SIZES["base"]))
            val_lbl.setStyleSheet(f"color: {T.TEXT_PRIMARY}; background: transparent;")
            row.addWidget(val_lbl)
            v.addLayout(row)

        v.addSpacing(T.SPACING["xl"])
        check = _primary_btn("Check for Updates", 180)
        v.addWidget(check)
        v.addStretch()

    def reset(self):
        pass
