import logging

from PyQt5.QtWidgets import QLabel, QWidget, QHBoxLayout, QApplication
from PyQt5.QtCore import Qt, QTimer, QPropertyAnimation, QEasingCurve, QRect
from PyQt5.QtGui import QFont

import ui.theme as T

log = logging.getLogger("CortexAI")

_DURATION_MS  = 3000
_ANIM_IN_MS   = 200
_ANIM_OUT_MS  = 200


class Toast(QWidget):
    """Slide-in toast notification that auto-dismisses."""

    def __init__(self, message: str, kind: str = "info", parent=None):
        super().__init__(parent, Qt.Tool | Qt.FramelessWindowHint | Qt.WindowStaysOnTopHint)
        self.setAttribute(Qt.WA_TranslucentBackground)
        self.setAttribute(Qt.WA_ShowWithoutActivating)

        bg, fg = {
            "info":    (T.INFO_BG,    T.INFO),
            "success": (T.SUCCESS_BG, T.SUCCESS),
            "warning": (T.WARNING_BG, T.WARNING),
            "error":   (T.ERROR_BG,   T.ERROR),
        }.get(kind, (T.BG_ELEVATED, T.TEXT_PRIMARY))

        row = QHBoxLayout(self)
        row.setContentsMargins(14, 10, 14, 10)

        dot = QLabel("●")
        dot.setStyleSheet(f"color: {fg}; font-size: 8px; background: transparent;")
        row.addWidget(dot)
        row.addSpacing(6)

        lbl = QLabel(message)
        lbl.setFont(QFont(T.FONT_FAMILY, T.FONT_SIZES["sm"]))
        lbl.setStyleSheet(f"color: {T.TEXT_PRIMARY}; background: transparent;")
        row.addWidget(lbl)

        self.setStyleSheet(
            f"QWidget {{ background: {bg}; border: 1px solid {T.BG_BORDER}; "
            f"  border-radius: {T.RADIUS['lg']}px; }}"
        )
        self.adjustSize()

        self._dismiss_timer = QTimer(self)
        self._dismiss_timer.setSingleShot(True)
        self._dismiss_timer.timeout.connect(self._slide_out)

    def show_in(self, parent: QWidget) -> None:
        if not parent:
            return
        pr = parent.rect()
        w, h = self.width(), self.height()
        x = pr.right() - w - 20
        y_final = pr.bottom() - h - 20
        y_start = y_final + 40

        self.setParent(parent)
        self.setGeometry(x, y_start, w, h)
        self.show()
        self.raise_()

        anim = QPropertyAnimation(self, b"geometry", self)
        anim.setDuration(_ANIM_IN_MS)
        anim.setEasingCurve(QEasingCurve.OutCubic)
        anim.setStartValue(QRect(x, y_start, w, h))
        anim.setEndValue(QRect(x, y_final, w, h))
        anim.start()
        self._anim = anim

        self._dismiss_timer.start(_DURATION_MS)

    def _slide_out(self):
        pr = self.parent()
        if not pr:
            self.hide()
            return
        geo = self.geometry()
        anim = QPropertyAnimation(self, b"geometry", self)
        anim.setDuration(_ANIM_OUT_MS)
        anim.setEasingCurve(QEasingCurve.InCubic)
        anim.setStartValue(geo)
        anim.setEndValue(QRect(geo.x(), geo.y() + 40, geo.width(), geo.height()))
        anim.finished.connect(self.hide)
        anim.start()
        self._anim_out = anim

    def reset(self):
        self._dismiss_timer.stop()
        self.hide()


def show_toast(message: str, kind: str = "info", parent: QWidget = None) -> Toast:
    if parent is None:
        parent = QApplication.activeWindow()
    t = Toast(message, kind, parent)
    t.show_in(parent)
    log.debug(f"Toast [{kind}]: {message}")
    return t
