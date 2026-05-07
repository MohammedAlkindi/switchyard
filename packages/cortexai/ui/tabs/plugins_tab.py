import logging
import os

from PyQt5.QtWidgets import (
    QWidget, QVBoxLayout, QHBoxLayout, QLabel, QPushButton,
    QScrollArea, QFrame,
)
from PyQt5.QtCore import Qt
from PyQt5.QtGui import QFont

import ui.theme as T

log = logging.getLogger("CortexAI")


class PluginsTab(QWidget):
    """Lists loaded plugins and their status."""

    def __init__(self, plugin_manager, parent=None):
        super().__init__(parent)
        self._plugin_manager = plugin_manager
        self._setup_ui()

    def _setup_ui(self):
        self.setStyleSheet(f"background: {T.BG_BASE};")
        root = QVBoxLayout(self)
        root.setContentsMargins(0, 0, 0, 0)
        root.setSpacing(0)

        # Header
        header = QWidget()
        header.setFixedHeight(52)
        header.setAttribute(Qt.WA_StyledBackground, True)
        header.setStyleSheet(
            f"background: {T.BG_SURFACE}; border-bottom: 1px solid {T.BG_BORDER};"
        )
        h_row = QHBoxLayout(header)
        h_row.setContentsMargins(T.SPACING["xl"], 0, T.SPACING["lg"], 0)
        title = QLabel("Plugins")
        title.setFont(QFont(T.FONT_FAMILY, T.FONT_SIZES["md"], T.FONT_WEIGHTS["semibold"]))
        title.setStyleSheet(f"color: {T.TEXT_PRIMARY}; background: transparent;")
        h_row.addWidget(title)
        h_row.addStretch()

        open_btn = self._hdr_btn("Open Plugins Folder")
        open_btn.clicked.connect(self._open_folder)
        h_row.addWidget(open_btn)

        reload_btn = self._hdr_btn("Reload All")
        reload_btn.clicked.connect(self._reload)
        h_row.addWidget(reload_btn)
        root.addWidget(header)

        # Scrollable list
        scroll = QScrollArea()
        scroll.setWidgetResizable(True)
        scroll.setStyleSheet(f"QScrollArea {{ border: none; background: {T.BG_BASE}; }}")
        self._content = QWidget()
        self._content.setStyleSheet("background: transparent;")
        self._list_layout = QVBoxLayout(self._content)
        self._list_layout.setContentsMargins(T.SPACING["xl"], T.SPACING["xl"],
                                              T.SPACING["xl"], T.SPACING["xl"])
        self._list_layout.setSpacing(T.SPACING["md"])
        scroll.setWidget(self._content)
        root.addWidget(scroll, 1)

        self._refresh_list()

    def _refresh_list(self):
        # Clear existing items
        while self._list_layout.count() > 0:
            item = self._list_layout.takeAt(0)
            if item.widget():
                item.widget().deleteLater()

        plugins = self._plugin_manager.get_all()
        if not plugins:
            empty = QLabel("No plugins loaded. Drop .py files into the plugins/ folder.")
            empty.setFont(QFont(T.FONT_FAMILY, T.FONT_SIZES["md"]))
            empty.setStyleSheet(f"color: {T.TEXT_TERTIARY}; background: transparent;")
            empty.setAlignment(Qt.AlignCenter)
            self._list_layout.addWidget(empty)
        else:
            for plugin in plugins:
                row = self._make_plugin_row(plugin)
                self._list_layout.addWidget(row)

        self._list_layout.addStretch()

    def _make_plugin_row(self, plugin) -> QFrame:
        frame = QFrame()
        frame.setStyleSheet(
            f"QFrame {{ background: {T.BG_ELEVATED}; border: 1px solid {T.BG_BORDER}; "
            f"border-radius: {T.RADIUS['lg']}px; }}"
            f"QLabel {{ border: none; background: transparent; }}"
        )
        row = QHBoxLayout(frame)
        row.setContentsMargins(T.SPACING["lg"], T.SPACING["md"],
                                T.SPACING["lg"], T.SPACING["md"])

        name = getattr(plugin, "__class__", type(plugin)).__name__
        name_lbl = QLabel(name)
        name_lbl.setFont(QFont(T.FONT_FAMILY, T.FONT_SIZES["base"], T.FONT_WEIGHTS["medium"]))
        name_lbl.setStyleSheet(f"color: {T.TEXT_PRIMARY};")
        row.addWidget(name_lbl)
        row.addStretch()

        status = QLabel("● Loaded")
        status.setFont(QFont(T.FONT_FAMILY, T.FONT_SIZES["sm"]))
        status.setStyleSheet(f"color: {T.SUCCESS};")
        row.addWidget(status)
        return frame

    def _open_folder(self):
        from pathlib import Path
        plugins_dir = str(Path("plugins").resolve())
        os.startfile(plugins_dir) if os.name == "nt" else None

    def _reload(self):
        self._plugin_manager._plugins.clear()
        from core.ai_core import AICore
        # Reload — host is not easily accessible here, just refresh the display
        self._refresh_list()

    @staticmethod
    def _hdr_btn(text: str) -> QPushButton:
        btn = QPushButton(text)
        btn.setFixedHeight(28)
        btn.setFont(QFont(T.FONT_FAMILY, T.FONT_SIZES["sm"]))
        btn.setStyleSheet(
            f"QPushButton {{ background: transparent; color: {T.TEXT_TERTIARY}; "
            f"  border: 1px solid {T.BG_BORDER}; border-radius: {T.RADIUS['md']}px; "
            f"  padding: 0 12px; }}"
            f"QPushButton:hover {{ color: {T.TEXT_PRIMARY}; border-color: {T.BG_OVERLAY}; }}"
        )
        return btn

    def reset(self):
        pass
