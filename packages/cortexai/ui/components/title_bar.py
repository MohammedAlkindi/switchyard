import logging

from PyQt5.QtWidgets import QWidget, QHBoxLayout, QLabel, QPushButton
from PyQt5.QtCore import Qt, QPoint
from PyQt5.QtGui import QFont

import ui.theme as T

log = logging.getLogger("CortexAI")


class TitleBar(QWidget):
    """Custom frameless title bar with drag, min/max/close controls."""

    HEIGHT = 40

    def __init__(self, parent=None):
        super().__init__(parent)
        self.setFixedHeight(self.HEIGHT)
        self.setAttribute(Qt.WA_StyledBackground, True)
        self.setStyleSheet(f"background: {T.BG_BASE};")

        self._drag_pos: QPoint = QPoint()

        row = QHBoxLayout(self)
        row.setContentsMargins(14, 0, 10, 0)
        row.setSpacing(0)

        # Logo mark
        logo = QLabel("C")
        logo.setFixedSize(22, 22)
        logo.setAlignment(Qt.AlignCenter)
        logo.setStyleSheet(
            f"background: {T.BRAND_PRIMARY}; color: {T.TEXT_ON_BRAND}; "
            f"border-radius: {T.RADIUS['md']}px; font-size: 11px; font-weight: 700;"
        )
        row.addWidget(logo)
        row.addSpacing(T.SPACING["sm"])

        # App name
        name = QLabel("CortexAI")
        name.setFont(QFont(T.FONT_FAMILY, T.FONT_SIZES["md"], T.FONT_WEIGHTS["medium"]))
        name.setStyleSheet(f"color: {T.TEXT_PRIMARY}; background: transparent;")
        row.addWidget(name)

        row.addStretch()

        # Window controls
        for symbol, tip, slot in (
            ("─", "Minimise", self._on_minimise),
            ("□", "Maximise", self._on_maximise),
            ("✕", "Close",    self._on_close),
        ):
            btn = _ControlButton(symbol, tip)
            btn.clicked.connect(slot)
            if symbol == "✕":
                btn.setProperty("is_close", True)
                btn.setStyleSheet(btn.styleSheet() + _close_extra())
            row.addWidget(btn)

    # ── Window control handlers ───────────────────────────────────────────────

    def _on_minimise(self):
        win = self.window()
        if win:
            win.showMinimized()

    def _on_maximise(self):
        win = self.window()
        if not win:
            return
        if win.isMaximized():
            win.showNormal()
        else:
            win.showMaximized()

    def _on_close(self):
        win = self.window()
        if win:
            win.close()

    # ── Drag support ──────────────────────────────────────────────────────────

    def mousePressEvent(self, event):
        if event.button() == Qt.LeftButton:
            self._drag_pos = event.globalPos() - self.window().frameGeometry().topLeft()

    def mouseMoveEvent(self, event):
        if event.buttons() == Qt.LeftButton and not self._drag_pos.isNull():
            win = self.window()
            if win and not win.isMaximized():
                win.move(event.globalPos() - self._drag_pos)

    def mouseDoubleClickEvent(self, event):
        if event.button() == Qt.LeftButton:
            self._on_maximise()

    def reset(self):
        pass


class _ControlButton(QPushButton):
    def __init__(self, symbol: str, tooltip: str, parent=None):
        super().__init__(symbol, parent)
        self.setFixedSize(32, 32)
        self.setToolTip(tooltip)
        self.setCursor(Qt.PointingHandCursor)
        self.setStyleSheet(
            f"QPushButton {{ background: transparent; color: {T.TEXT_TERTIARY}; "
            f"  border: none; border-radius: {T.RADIUS['md']}px; font-size: 12px; }}"
            f"QPushButton:hover {{ background: {T.BG_OVERLAY}; color: {T.TEXT_PRIMARY}; }}"
        )


def _close_extra() -> str:
    return f"QPushButton:hover {{ background: {T.ERROR_BG}; color: {T.ERROR}; }}"
