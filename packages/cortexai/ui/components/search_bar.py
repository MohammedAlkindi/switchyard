import logging

from PyQt5.QtWidgets import (
    QWidget, QHBoxLayout, QLineEdit, QLabel, QPushButton,
)
from PyQt5.QtCore import Qt, pyqtSignal
from PyQt5.QtGui import QFont

import ui.theme as T

log = logging.getLogger("CortexAI")


class ConvSearchBar(QWidget):
    """Inline search bar for the chat view."""

    search_changed = pyqtSignal(str)   # text changed
    next_requested = pyqtSignal()      # ▼ button
    prev_requested = pyqtSignal()      # ▲ button
    closed         = pyqtSignal()

    def __init__(self, parent=None):
        super().__init__(parent)
        self.setAttribute(Qt.WA_StyledBackground, True)
        self.setStyleSheet(
            f"background: {T.BG_SURFACE}; border-top: 1px solid {T.BG_BORDER};"
        )
        self.setFixedHeight(44)

        row = QHBoxLayout(self)
        row.setContentsMargins(T.SPACING["xl"], 0, T.SPACING["xl"], 0)
        row.setSpacing(T.SPACING["sm"])

        self._input = QLineEdit()
        self._input.setPlaceholderText("Search conversation…")
        self._input.setFont(QFont(T.FONT_FAMILY, T.FONT_SIZES["sm"]))
        self._input.setStyleSheet(
            f"QLineEdit {{ background: {T.BG_ELEVATED}; color: {T.TEXT_PRIMARY}; "
            f"  border: 1px solid {T.BG_BORDER}; border-radius: {T.RADIUS['md']}px; "
            f"  padding: 4px 10px; }}"
            f"QLineEdit:focus {{ border-color: {T.BRAND_PRIMARY}; }}"
        )
        self._input.textChanged.connect(self.search_changed)
        self._input.returnPressed.connect(self.next_requested)
        row.addWidget(self._input, 1)

        self._count = QLabel("No results")
        self._count.setFont(QFont(T.FONT_FAMILY, T.FONT_SIZES["xs"]))
        self._count.setStyleSheet(f"color: {T.TEXT_TERTIARY}; background: transparent;")
        row.addWidget(self._count)

        for label, sig in (("▲", self.prev_requested), ("▼", self.next_requested)):
            btn = QPushButton(label)
            btn.setFixedSize(28, 28)
            btn.setCursor(Qt.PointingHandCursor)
            btn.setFont(QFont(T.FONT_FAMILY, T.FONT_SIZES["sm"]))
            btn.setStyleSheet(
                f"QPushButton {{ background: transparent; color: {T.TEXT_TERTIARY}; "
                f"  border: 1px solid {T.BG_BORDER}; border-radius: {T.RADIUS['sm']}px; }}"
                f"QPushButton:hover {{ color: {T.TEXT_PRIMARY}; border-color: {T.BG_OVERLAY}; }}"
            )
            btn.clicked.connect(sig)
            row.addWidget(btn)

        close = QPushButton("✕")
        close.setFixedSize(28, 28)
        close.setCursor(Qt.PointingHandCursor)
        close.setFont(QFont(T.FONT_FAMILY, T.FONT_SIZES["sm"]))
        close.setStyleSheet(
            f"QPushButton {{ background: transparent; color: {T.TEXT_TERTIARY}; border: none; "
            f"  border-radius: {T.RADIUS['sm']}px; }}"
            f"QPushButton:hover {{ color: {T.ERROR}; }}"
        )
        close.clicked.connect(self.closed)
        row.addWidget(close)

        self._current = 0

    def focus(self):
        self._input.setFocus()
        self._input.selectAll()

    def set_results(self, count: int, current: int = 0):
        self._current = current
        if count == 0:
            self._count.setText("No results")
        else:
            self._count.setText(f"{current + 1} / {count}")
