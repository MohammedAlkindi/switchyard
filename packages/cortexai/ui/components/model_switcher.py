from __future__ import annotations

import logging

from PyQt5.QtWidgets import (
    QWidget, QVBoxLayout, QHBoxLayout, QLabel, QPushButton, QFrame,
)
from PyQt5.QtCore import Qt, pyqtSignal, QPoint
from PyQt5.QtGui import QFont

import ui.theme as T
from ui.strings import MODELS, MODEL_SWITCHER_TITLE, MODEL_BADGE_RECOMMENDED

log = logging.getLogger("CortexAI")

_PROVIDER_LABELS = {"anthropic": "Anthropic", "openai": "OpenAI", "auto": ""}


class ModelSwitcher(QWidget):
    """Floating popover for selecting the active model."""

    model_selected = pyqtSignal(str)   # emits model id

    WIDTH  = 320

    def __init__(self, parent=None):
        super().__init__(parent, Qt.Popup | Qt.FramelessWindowHint)
        self.setAttribute(Qt.WA_TranslucentBackground)
        self.setFixedWidth(self.WIDTH)

        self._selected_id: str = "claude-sonnet-4-20250514"

        outer = QVBoxLayout(self)
        outer.setContentsMargins(0, 0, 0, 0)

        inner = QWidget()
        inner.setAttribute(Qt.WA_StyledBackground, True)
        inner.setStyleSheet(
            f"QWidget {{ background: {T.BG_ELEVATED}; "
            f"border: 1px solid {T.BG_BORDER}; "
            f"border-radius: {T.RADIUS['lg']}px; }}"
        )
        v = QVBoxLayout(inner)
        v.setContentsMargins(T.SPACING["md"], T.SPACING["md"], T.SPACING["md"], T.SPACING["md"])
        v.setSpacing(2)

        title = QLabel(MODEL_SWITCHER_TITLE)
        title.setFont(QFont(T.FONT_FAMILY, T.FONT_SIZES["md"], T.FONT_WEIGHTS["medium"]))
        title.setStyleSheet(f"color: {T.TEXT_PRIMARY}; border: none; background: transparent;")
        v.addWidget(title)
        v.addSpacing(T.SPACING["sm"])

        # Divider
        sep = QFrame()
        sep.setFrameShape(QFrame.HLine)
        sep.setStyleSheet(f"border: none; border-top: 1px solid {T.BG_BORDER};")
        sep.setFixedHeight(1)
        v.addWidget(sep)
        v.addSpacing(T.SPACING["xs"])

        # Group by provider
        self._rows: dict[str, "_ModelRow"] = {}
        current_provider = None
        for m in MODELS:
            prov = m["provider"]
            label = _PROVIDER_LABELS.get(prov, prov.title())
            if prov != "auto" and prov != current_provider:
                if label:
                    pl = QLabel(label.upper())
                    pl.setStyleSheet(
                        f"color: {T.TEXT_TERTIARY}; font-size: {T.FONT_SIZES['xs']}px; "
                        f"letter-spacing: 0.08em; padding: 4px 0 2px 4px; "
                        f"border: none; background: transparent;"
                    )
                    v.addWidget(pl)
                current_provider = prov

            row = _ModelRow(m, active=(m["id"] == self._selected_id))
            row.clicked.connect(self._on_row_clicked)
            v.addWidget(row)
            self._rows[m["id"]] = row

        outer.addWidget(inner)

    # ── Public ────────────────────────────────────────────────────────────────

    def set_active(self, model_id: str) -> None:
        self._selected_id = model_id
        for mid, row in self._rows.items():
            row.set_active(mid == model_id)

    def show_below(self, anchor: QWidget) -> None:
        pos = anchor.mapToGlobal(QPoint(0, anchor.height() + 4))
        # Keep on screen
        screen = anchor.screen().availableGeometry()
        x = min(pos.x(), screen.right() - self.WIDTH - 10)
        self.move(x, pos.y())
        self.adjustSize()
        self.show()
        self.raise_()

    def reset(self):
        self.hide()

    # ── Slots ─────────────────────────────────────────────────────────────────

    def _on_row_clicked(self, model_id: str) -> None:
        self.set_active(model_id)
        self.model_selected.emit(model_id)
        self.hide()
        log.debug(f"Model selected: {model_id}")


class _ModelRow(QWidget):
    clicked = pyqtSignal(str)

    def __init__(self, model_data: dict, active: bool = False, parent=None):
        super().__init__(parent)
        self._id = model_data["id"]
        self._active = active
        self.setFixedHeight(44)
        self.setCursor(Qt.PointingHandCursor)
        self.setAttribute(Qt.WA_StyledBackground, True)

        row = QHBoxLayout(self)
        row.setContentsMargins(T.SPACING["sm"], 0, T.SPACING["sm"], 0)
        row.setSpacing(T.SPACING["sm"])

        text_col = QVBoxLayout()
        text_col.setSpacing(1)

        name_row = QHBoxLayout()
        name_row.setSpacing(6)
        name = QLabel(model_data["label"])
        name.setFont(QFont(T.FONT_FAMILY, T.FONT_SIZES["base"]))
        name.setStyleSheet(f"color: {T.TEXT_PRIMARY}; background: transparent; border: none;")
        name_row.addWidget(name)

        if model_data.get("recommended"):
            badge = QLabel(MODEL_BADGE_RECOMMENDED)
            badge.setStyleSheet(
                f"color: {T.TEXT_ON_BRAND}; background: {T.BRAND_PRIMARY}; "
                f"border-radius: {T.RADIUS['sm']}px; font-size: 9px; "
                f"font-weight: 600; padding: 1px 5px; border: none;"
            )
            name_row.addWidget(badge)
        name_row.addStretch()

        desc = QLabel(model_data["description"])
        desc.setFont(QFont(T.FONT_FAMILY, T.FONT_SIZES["xs"]))
        desc.setStyleSheet(f"color: {T.TEXT_TERTIARY}; background: transparent; border: none;")

        text_col.addLayout(name_row)
        text_col.addWidget(desc)
        row.addLayout(text_col)

        self._refresh()

    def set_active(self, active: bool):
        self._active = active
        self._refresh()

    def _refresh(self):
        if self._active:
            self.setStyleSheet(
                f"background: {T.BG_OVERLAY}; border-left: 2px solid {T.BRAND_PRIMARY}; "
                f"border-radius: {T.RADIUS['md']}px;"
            )
        else:
            self.setStyleSheet(
                f"background: transparent; border-left: 2px solid transparent; "
                f"border-radius: {T.RADIUS['md']}px;"
            )

    def enterEvent(self, _e):
        if not self._active:
            self.setStyleSheet(
                f"background: {T.BG_OVERLAY}; border-left: 2px solid transparent; "
                f"border-radius: {T.RADIUS['md']}px;"
            )

    def leaveEvent(self, _e):
        self._refresh()

    def mousePressEvent(self, event):
        if event.button() == Qt.LeftButton:
            self.clicked.emit(self._id)
