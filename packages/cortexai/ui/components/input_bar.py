import logging

from PyQt5.QtWidgets import (
    QWidget, QHBoxLayout, QVBoxLayout, QPlainTextEdit, QPushButton, QLabel,
    QSizePolicy,
)
from PyQt5.QtCore import Qt, pyqtSignal, QTimer
from PyQt5.QtGui import QFont, QKeyEvent

import ui.theme as T
from ui.strings import INPUT_PLACEHOLDER, SEND_TOOLTIP, STOP_TOOLTIP, TOKEN_COUNT_FMT

log = logging.getLogger("CortexAI")

_APPROX_CHARS_PER_TOKEN = 4
_MAX_TOKENS = 200_000


class InputBar(QWidget):
    """Chat input area with send/stop button and model pill."""

    send_requested  = pyqtSignal(str)   # emits user text
    stop_requested  = pyqtSignal()
    model_pill_clicked = pyqtSignal()

    def __init__(self, parent=None):
        super().__init__(parent)
        self.setAttribute(Qt.WA_StyledBackground, True)
        self._is_streaming = False
        self._current_model = "claude-sonnet-4"
        self._setup_ui()

    def _setup_ui(self):
        self.setStyleSheet(f"background: {T.BG_BASE};")

        outer = QVBoxLayout(self)
        outer.setContentsMargins(T.SPACING["xl"], T.SPACING["md"], T.SPACING["xl"], T.SPACING["lg"])
        outer.setSpacing(0)

        # Container pill
        container = QWidget()
        container.setAttribute(Qt.WA_StyledBackground, True)
        self._container = container
        self._update_container_style(focused=False)

        v = QVBoxLayout(container)
        v.setContentsMargins(T.SPACING["lg"], T.SPACING["md"], T.SPACING["md"], T.SPACING["md"])
        v.setSpacing(T.SPACING["sm"])

        # Text input
        self._input = _AutoGrowEdit()
        self._input.setPlaceholderText(INPUT_PLACEHOLDER)
        self._input.setFont(QFont(T.FONT_FAMILY, T.FONT_SIZES["md"]))
        self._input.setStyleSheet(
            f"QPlainTextEdit {{ background: transparent; border: none; "
            f"color: {T.TEXT_PRIMARY}; padding: 0; }}"
        )
        self._input.send_requested.connect(self._on_send)
        self._input.textChanged.connect(self._on_text_changed)
        self._input.focusChanged.connect(self._update_container_style)
        v.addWidget(self._input)

        # Bottom toolbar
        toolbar = QHBoxLayout()
        toolbar.setSpacing(T.SPACING["sm"])

        # Attach button
        attach = QPushButton("⊕")
        attach.setFixedSize(28, 28)
        attach.setToolTip("Attach file")
        attach.setCursor(Qt.PointingHandCursor)
        attach.setStyleSheet(
            f"QPushButton {{ background: transparent; color: {T.TEXT_TERTIARY}; "
            f"  border: none; border-radius: {T.RADIUS['md']}px; font-size: 16px; }}"
            f"QPushButton:hover {{ color: {T.TEXT_SECONDARY}; }}"
        )
        toolbar.addWidget(attach)

        # Model pill
        self._model_pill = QPushButton(self._current_model + " ▾")
        self._model_pill.setFixedHeight(26)
        self._model_pill.setCursor(Qt.PointingHandCursor)
        self._model_pill.setFont(QFont(T.FONT_FAMILY, T.FONT_SIZES["xs"]))
        self._model_pill.setStyleSheet(
            f"QPushButton {{ background: {T.BG_OVERLAY}; color: {T.TEXT_SECONDARY}; "
            f"  border: 1px solid {T.BG_BORDER}; "
            f"  border-radius: {T.RADIUS['full']}px; padding: 0 10px; }}"
            f"QPushButton:hover {{ border-color: {T.BRAND_MUTED}; color: {T.TEXT_PRIMARY}; }}"
        )
        self._model_pill.clicked.connect(self.model_pill_clicked)
        toolbar.addWidget(self._model_pill)

        toolbar.addStretch()

        # Token count
        self._token_label = QLabel(TOKEN_COUNT_FMT.format(count=0))
        self._token_label.setFont(QFont(T.FONT_FAMILY, T.FONT_SIZES["xs"]))
        self._token_label.setStyleSheet(f"color: {T.TEXT_TERTIARY}; background: transparent;")
        toolbar.addWidget(self._token_label)
        toolbar.addSpacing(T.SPACING["sm"])

        # Send / stop button
        self._send_btn = _SendButton()
        self._send_btn.clicked.connect(self._on_send_btn)
        toolbar.addWidget(self._send_btn)

        v.addLayout(toolbar)
        outer.addWidget(container)

    # ── Public API ────────────────────────────────────────────────────────────

    def set_streaming(self, streaming: bool) -> None:
        self._is_streaming = streaming
        self._send_btn.set_stop_mode(streaming)
        self._input.setEnabled(not streaming)
        if streaming:
            self._input.setPlaceholderText("Generating…")
        else:
            self._input.setPlaceholderText(INPUT_PLACEHOLDER)

    def set_model_label(self, label: str) -> None:
        self._current_model = label
        self._model_pill.setText(label + " ▾")

    def clear_input(self) -> None:
        self._input.clear()

    def focus_input(self) -> None:
        self._input.setFocus()

    def reset(self) -> None:
        self.clear_input()
        self.set_streaming(False)

    # ── Internal ──────────────────────────────────────────────────────────────

    def _update_container_style(self, focused: bool = False) -> None:
        border_color = T.BRAND_PRIMARY if focused else T.BG_BORDER
        self._container.setStyleSheet(
            f"QWidget {{ background: {T.BG_ELEVATED}; "
            f"border: 1px solid {border_color}; "
            f"border-radius: {T.RADIUS['2xl']}px; }}"
        )

    def _on_text_changed(self) -> None:
        text  = self._input.toPlainText()
        count = max(1, len(text) // _APPROX_CHARS_PER_TOKEN)
        self._token_label.setText(TOKEN_COUNT_FMT.format(count=count if text else 0))
        self._send_btn.set_enabled(bool(text.strip()) and not self._is_streaming)

    def _on_send(self) -> None:
        text = self._input.toPlainText().strip()
        if text and not self._is_streaming:
            log.debug("InputBar: send requested")
            self.send_requested.emit(text)
            self.clear_input()

    def _on_send_btn(self) -> None:
        if self._is_streaming:
            self.stop_requested.emit()
        else:
            self._on_send()


class _AutoGrowEdit(QPlainTextEdit):
    send_requested = pyqtSignal()
    focusChanged   = pyqtSignal(bool)

    MIN_H = 28
    MAX_H = 160

    def __init__(self, parent=None):
        super().__init__(parent)
        self.setMinimumHeight(self.MIN_H)
        self.setMaximumHeight(self.MAX_H)
        self.setVerticalScrollBarPolicy(Qt.ScrollBarAsNeeded)
        self.document().contentsChanged.connect(self._adjust_height)

    def keyPressEvent(self, event: QKeyEvent):
        if event.key() in (Qt.Key_Return, Qt.Key_Enter):
            if event.modifiers() & Qt.ShiftModifier:
                super().keyPressEvent(event)  # new line
            else:
                self.send_requested.emit()
                return
        elif event.key() == Qt.Key_Escape:
            self.send_requested.emit()  # treated by parent as stop
        else:
            super().keyPressEvent(event)

    def focusInEvent(self, event):
        super().focusInEvent(event)
        self.focusChanged.emit(True)

    def focusOutEvent(self, event):
        super().focusOutEvent(event)
        self.focusChanged.emit(False)

    def _adjust_height(self):
        doc_h = int(self.document().size().height()) + 8
        self.setFixedHeight(max(self.MIN_H, min(doc_h, self.MAX_H)))


class _SendButton(QPushButton):
    def __init__(self, parent=None):
        super().__init__("↑", parent)
        self.setFixedSize(36, 36)
        self.setToolTip(SEND_TOOLTIP)
        self.setCursor(Qt.PointingHandCursor)
        self._stop_mode = False
        self._active    = False
        self._refresh()

    def set_stop_mode(self, stop: bool) -> None:
        self._stop_mode = stop
        self.setToolTip(STOP_TOOLTIP if stop else SEND_TOOLTIP)
        self.setText("■" if stop else "↑")
        self._refresh()

    def set_enabled(self, enabled: bool) -> None:
        self._active = enabled
        self._refresh()

    def _refresh(self):
        if self._stop_mode:
            bg, hover, color = T.ERROR_BG, T.ERROR, T.ERROR
        elif self._active:
            bg, hover, color = T.BRAND_PRIMARY, T.BRAND_HOVER, T.TEXT_ON_BRAND
        else:
            bg, hover, color = T.BG_OVERLAY, T.BG_OVERLAY, T.TEXT_TERTIARY
        self.setStyleSheet(
            f"QPushButton {{ background: {bg}; color: {color}; border: none; "
            f"  border-radius: {T.RADIUS['full']}px; font-size: 16px; font-weight: 600; }}"
            f"QPushButton:hover {{ background: {hover}; }}"
        )
