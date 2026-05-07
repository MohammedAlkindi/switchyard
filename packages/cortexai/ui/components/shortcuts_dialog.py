from PyQt5.QtWidgets import (
    QDialog, QVBoxLayout, QGridLayout, QLabel, QPushButton,
)
from PyQt5.QtCore import Qt
from PyQt5.QtGui import QFont

import ui.theme as T
from ui.strings import SHORTCUT_DEFS, SHORTCUTS_TITLE


class ShortcutsDialog(QDialog):
    def __init__(self, parent=None):
        super().__init__(parent)
        self.setWindowTitle(SHORTCUTS_TITLE)
        self.setMinimumWidth(460)
        self.setStyleSheet(
            f"QDialog {{ background: {T.BG_ELEVATED}; color: {T.TEXT_PRIMARY}; }}"
            f"QLabel {{ background: transparent; }}"
        )
        v = QVBoxLayout(self)
        v.setContentsMargins(T.SPACING["2xl"], T.SPACING["2xl"],
                              T.SPACING["2xl"], T.SPACING["2xl"])
        v.setSpacing(T.SPACING["lg"])

        title = QLabel(SHORTCUTS_TITLE)
        title.setFont(QFont(T.FONT_FAMILY, T.FONT_SIZES["lg"], T.FONT_WEIGHTS["semibold"]))
        title.setStyleSheet(f"color: {T.TEXT_PRIMARY};")
        v.addWidget(title)

        grid = QGridLayout()
        grid.setSpacing(T.SPACING["sm"])
        for i, (keys, desc) in enumerate(SHORTCUT_DEFS):
            k = QLabel(keys)
            k.setFont(QFont("Consolas", T.FONT_SIZES["sm"]))
            k.setStyleSheet(
                f"background: {T.BG_OVERLAY}; color: {T.BRAND_PRIMARY}; "
                f"border-radius: {T.RADIUS['sm']}px; padding: 2px 6px;"
            )
            d = QLabel(desc)
            d.setFont(QFont(T.FONT_FAMILY, T.FONT_SIZES["base"]))
            d.setStyleSheet(f"color: {T.TEXT_SECONDARY};")
            grid.addWidget(k, i, 0)
            grid.addWidget(d, i, 1)
        v.addLayout(grid)

        close_btn = QPushButton("Close")
        close_btn.setFixedHeight(36)
        close_btn.setCursor(Qt.PointingHandCursor)
        close_btn.setStyleSheet(
            f"QPushButton {{ background: {T.BG_OVERLAY}; color: {T.TEXT_PRIMARY}; "
            f"  border: none; border-radius: {T.RADIUS['md']}px; }}"
            f"QPushButton:hover {{ background: {T.BG_BORDER}; }}"
        )
        close_btn.clicked.connect(self.accept)
        v.addWidget(close_btn)
