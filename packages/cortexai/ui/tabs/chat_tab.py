from __future__ import annotations

import logging
from datetime import datetime
from typing import Dict, List, Optional

from PyQt5.QtWidgets import (
    QWidget, QVBoxLayout, QHBoxLayout, QLabel, QPushButton,
    QScrollArea, QFrame, QSizePolicy, QApplication,
)
from PyQt5.QtCore import Qt, QTimer, pyqtSignal
from PyQt5.QtGui import QFont

import ui.theme as T
from ui.strings import (
    GREETING_MORNING, GREETING_AFTERNOON, GREETING_EVENING, GREETING_SUBTITLE,
    CHIP_EMAIL, CHIP_RESEARCH, CHIP_CODE, CHIP_ANALYZE, CHIP_PROMPTS,
    NO_API_KEY_HEADING, NO_API_KEY_BODY, NO_API_KEY_BTN,
    ERROR_RATE_LIMIT, ERROR_AUTH, ERROR_GENERIC, ERROR_RETRY,
    DEFAULT_MODEL_ID, MODELS, COPIED_TOAST,
)
from ui.components.message_bubble import UserBubble, AssistantBubble
from ui.components.input_bar import InputBar
from ui.components.model_switcher import ModelSwitcher
from ui.components.toast import show_toast
from ui.components.search_bar import ConvSearchBar
from core.conversation_store import ConversationStore
from core.user_settings import load_user_settings

log = logging.getLogger("CortexAI")

_CACHED_DISPLAY_NAME: Optional[str] = None


def _display_name() -> str:
    global _CACHED_DISPLAY_NAME
    if _CACHED_DISPLAY_NAME is None:
        try:
            _CACHED_DISPLAY_NAME = load_user_settings().get("display_name", "").strip()
        except Exception:
            _CACHED_DISPLAY_NAME = ""
    return _CACHED_DISPLAY_NAME


def _greeting() -> str:
    h = datetime.now().hour
    if h < 12:
        return GREETING_MORNING
    if h < 17:
        return GREETING_AFTERNOON
    return GREETING_EVENING


_DEFAULT_SYSTEM_PROMPT = (
    "You are CortexAI, a helpful, accurate, and concise AI assistant built into a "
    "desktop application. Respond clearly and use markdown formatting where appropriate."
)


class ChatTab(QWidget):
    """Main chat tab — empty state, message list, streaming, persistence."""

    open_settings_requested = pyqtSignal()
    conversation_updated    = pyqtSignal(dict)

    def __init__(self, ai_core, parent=None):
        super().__init__(parent)
        self._ai_core = ai_core
        self._store   = ConversationStore()
        self._conv_id: Optional[str] = None
        self._worker  = None
        self._last_assistant_bubble: Optional[AssistantBubble] = None
        self._messages: List[Dict[str, str]] = []
        self._model_id = DEFAULT_MODEL_ID
        self._model_label = self._label_for_id(DEFAULT_MODEL_ID)

        saved = load_user_settings()
        self.system_prompt = saved.get("system_prompt", "").strip() or _DEFAULT_SYSTEM_PROMPT

        self._search_results: list = []
        self._search_cursor: int = -1
        self._search_query: str = ""

        self._message_widgets: list = []
        self._stream_start: Optional[datetime] = None

        self._model_switcher = ModelSwitcher(self)
        self._model_switcher.model_selected.connect(self._on_model_selected)

        self._setup_ui()

    # ── UI construction ───────────────────────────────────────────────────────

    def _setup_ui(self):
        self.setStyleSheet(f"background: {T.BG_BASE};")
        v = QVBoxLayout(self)
        v.setContentsMargins(0, 0, 0, 0)
        v.setSpacing(0)

        self._scroll = QScrollArea()
        self._scroll.setWidgetResizable(True)
        self._scroll.setHorizontalScrollBarPolicy(Qt.ScrollBarAlwaysOff)
        self._scroll.setVerticalScrollBarPolicy(Qt.ScrollBarAsNeeded)
        self._scroll.setStyleSheet(
            f"QScrollArea {{ border: none; background: {T.BG_BASE}; }}"
        )

        self._msg_container = QWidget()
        self._msg_container.setStyleSheet(f"background: {T.BG_BASE};")
        self._msg_v = QVBoxLayout(self._msg_container)
        self._msg_v.setContentsMargins(
            T.SPACING["3xl"], T.SPACING["2xl"],
            T.SPACING["3xl"], T.SPACING["xl"],
        )
        self._msg_v.setSpacing(T.SPACING["xl"])
        self._msg_v.addStretch()

        self._scroll.setWidget(self._msg_container)
        v.addWidget(self._scroll, 1)

        # Inline search bar (hidden by default)
        self._search_bar = ConvSearchBar()
        self._search_bar.search_changed.connect(self._on_search)
        self._search_bar.next_requested.connect(self._on_search_next)
        self._search_bar.prev_requested.connect(self._on_search_prev)
        self._search_bar.closed.connect(self._hide_search)
        self._search_bar.hide()
        v.addWidget(self._search_bar)

        self._error_banner = _ErrorBanner()
        self._error_banner.retry_clicked.connect(self._retry_last)
        self._error_banner.hide()
        v.addWidget(self._error_banner)

        self._input_bar = InputBar()
        self._input_bar.send_requested.connect(self._on_send)
        self._input_bar.stop_requested.connect(self._on_stop)
        self._input_bar.model_pill_clicked.connect(self._on_model_pill_clicked)
        self._input_bar.set_model_label(self._model_label)
        v.addWidget(self._input_bar)

        self._show_empty_state()

        if not self._ai_core.anthropic_client.ready:
            self._show_no_key_state()

    def _show_empty_state(self):
        self._clear_messages()
        empty = _EmptyState()
        empty.chip_clicked.connect(self._on_chip)
        self._msg_v.insertWidget(0, empty)

    def _show_no_key_state(self):
        self._clear_messages()
        w = _NoKeyState()
        w.go_to_settings.connect(self.open_settings_requested)
        self._msg_v.insertWidget(0, w)

    # ── Messaging ─────────────────────────────────────────────────────────────

    def _on_send(self, text: str):
        if not self._ai_core.anthropic_client.ready:
            self._show_no_key_state()
            return

        self._remove_state_widgets()

        if self._conv_id is None:
            conv = self._store.create(model=self._model_id)
            self._conv_id = conv["id"]

        ts = datetime.now().strftime("%H:%M")
        bubble = UserBubble(text, ts)
        self._insert_message_widget(bubble)

        self._store.add_message(self._conv_id, "user", text)
        self._messages.append({"role": "user", "content": text})

        conv = self._store.get(self._conv_id)
        if conv:
            self.conversation_updated.emit(conv)

        self._last_assistant_bubble = AssistantBubble(self._model_label)
        self._last_assistant_bubble.regen_requested.connect(self._on_regenerate)
        self._last_assistant_bubble.copy_requested.connect(self._on_copy)
        self._insert_message_widget(self._last_assistant_bubble)
        self._last_assistant_bubble.start_stream()

        self._input_bar.set_streaming(True)
        self._error_banner.hide()

        self._stream_start = datetime.now()
        self._start_worker(list(self._messages))
        self._scroll_to_bottom()

    def _start_worker(self, messages: List[Dict]):
        from clients.anthropic_client import StreamingChatWorker
        from clients.openai_client import OpenAIClient

        if self._model_id.startswith("gpt-"):
            oai_client = OpenAIClient()
            if not oai_client.ready:
                self._on_stream_error("No OpenAI API key set. Add it in Settings → API Keys.")
                return
            from clients.openai_client import OpenAIStreamingWorker
            self._worker = OpenAIStreamingWorker(
                oai_client, messages, self.system_prompt, self._model_id, parent=self
            )
        elif self._model_id == "auto":
            effective_model = "claude-sonnet-4-20250514"
            self._worker = StreamingChatWorker(
                self._ai_core.anthropic_client,
                messages, self.system_prompt, effective_model, parent=self
            )
        else:
            self._worker = StreamingChatWorker(
                self._ai_core.anthropic_client,
                messages, self.system_prompt, self._model_id, parent=self
            )

        self._worker.token_ready.connect(self._on_token)
        self._worker.finished_ok.connect(self._on_stream_done)
        self._worker.error_occurred.connect(self._on_stream_error)
        self._worker.start()
        log.debug(f"ChatTab: started streaming worker, model={self._model_id}")

    def _on_token(self, token: str):
        if self._last_assistant_bubble:
            self._last_assistant_bubble.append_token(token)
        self._scroll_to_bottom()

    def _on_stream_done(self):
        latency_ms = 0
        if self._stream_start:
            latency_ms = int((datetime.now() - self._stream_start).total_seconds() * 1000)
            self._stream_start = None
        if self._last_assistant_bubble:
            self._last_assistant_bubble.finish_stream()
            text = self._last_assistant_bubble.get_text()
            self._messages.append({"role": "assistant", "content": text})
            if self._conv_id:
                token_est = max(1, int(len(text.split()) * 1.3))
                self._store.add_message(self._conv_id, "assistant", text,
                                        tokens=token_est, latency_ms=latency_ms)
                conv = self._store.get(self._conv_id)
                if conv:
                    self.conversation_updated.emit(conv)
        self._input_bar.set_streaming(False)
        self._worker = None
        log.debug("ChatTab: stream finished")

    def _on_stream_error(self, error: str):
        if self._last_assistant_bubble:
            self._last_assistant_bubble.finish_stream()
        self._input_bar.set_streaming(False)
        self._worker = None
        msg = self._friendly_error(error)
        self._error_banner.show_error(msg)
        log.warning(f"ChatTab: stream error: {error}")

    def _on_stop(self):
        if self._worker:
            self._worker.cancel()
            try:
                self._worker.finished_ok.disconnect()
                self._worker.error_occurred.disconnect()
                self._worker.token_ready.disconnect()
            except TypeError:
                pass
        if self._last_assistant_bubble:
            self._last_assistant_bubble.finish_stream()
        self._input_bar.set_streaming(False)
        self._worker = None
        log.debug("ChatTab: generation stopped by user")

    def _retry_last(self):
        if self._messages and self._messages[-1]["role"] == "assistant":
            self._messages.pop()
        if self._messages and self._messages[-1]["role"] == "user":
            self._start_worker(list(self._messages))
            self._input_bar.set_streaming(True)
            self._error_banner.hide()

    def _on_regenerate(self):
        if self._messages and self._messages[-1]["role"] == "assistant":
            self._messages.pop()
        old_bubble = self._last_assistant_bubble
        if old_bubble:
            if old_bubble in self._message_widgets:
                self._message_widgets.remove(old_bubble)
            self._msg_v.removeWidget(old_bubble)
            old_bubble.deleteLater()
        self._last_assistant_bubble = AssistantBubble(self._model_label)
        self._last_assistant_bubble.regen_requested.connect(self._on_regenerate)
        self._last_assistant_bubble.copy_requested.connect(self._on_copy)
        self._insert_message_widget(self._last_assistant_bubble)
        self._last_assistant_bubble.start_stream()
        self._input_bar.set_streaming(True)
        self._start_worker(list(self._messages))

    def _on_copy(self, text: str):
        QApplication.clipboard().setText(text)
        show_toast(COPIED_TOAST, "success", self)

    # ── Public API ────────────────────────────────────────────────────────────

    def new_conversation(self):
        self._on_stop()
        self._messages.clear()
        self._search_results = []
        self._search_cursor = -1
        self._search_query = ""
        self._message_widgets = []
        self._conv_id = None
        self._last_assistant_bubble = None
        self._show_empty_state()
        self._input_bar.focus_input()
        log.debug("ChatTab: new conversation started")

    def load_conversation(self, cid: str):
        conv = self._store.get(cid)
        if not conv:
            return
        self._on_stop()
        self._conv_id = cid
        self._messages = [
            {"role": m["role"], "content": m["content"]}
            for m in conv["messages"]
        ]
        self._search_results = []
        self._search_cursor = -1
        self._search_query = ""
        self._remove_state_widgets()
        self._clear_messages()
        for m in conv["messages"]:
            if m["role"] == "user":
                ts = m.get("timestamp", "")[:16].replace("T", " ")
                w = UserBubble(m["content"], ts)
            else:
                w = AssistantBubble(conv.get("model", self._model_label))
                w.set_text(m["content"])
                w.regen_requested.connect(self._on_regenerate)
                w.copy_requested.connect(self._on_copy)
                self._last_assistant_bubble = w
            self._insert_message_widget(w)
        self._scroll_to_bottom()

    def toggle_search(self):
        if self._search_bar.isVisible():
            self._hide_search()
        else:
            self._search_bar.show()
            self._search_bar.focus()

    def _hide_search(self):
        self._search_bar.hide()
        self._input_bar.focus_input()

    def _on_search(self, query: str):
        self._search_query = query
        if not query:
            self._search_results = []
            self._search_cursor = -1
            self._search_bar.set_results(0)
            return
        self._search_results = [
            i for i, m in enumerate(self._messages)
            if query.lower() in m.get("content", "").lower()
        ]
        self._search_cursor = 0 if self._search_results else -1
        self._search_bar.set_results(len(self._search_results), self._search_cursor)
        if self._search_results:
            self._scroll_to_message_index(self._search_results[self._search_cursor])

    def _on_search_next(self):
        if not self._search_results:
            return
        self._search_cursor = (self._search_cursor + 1) % len(self._search_results)
        self._search_bar.set_results(len(self._search_results), self._search_cursor)
        self._scroll_to_message_index(self._search_results[self._search_cursor])

    def _on_search_prev(self):
        if not self._search_results:
            return
        self._search_cursor = (self._search_cursor - 1) % len(self._search_results)
        self._search_bar.set_results(len(self._search_results), self._search_cursor)
        self._scroll_to_message_index(self._search_results[self._search_cursor])

    def _scroll_to_message_index(self, msg_idx: int):
        if 0 <= msg_idx < len(self._message_widgets):
            self._scroll.ensureWidgetVisible(self._message_widgets[msg_idx])

    def clear_chat(self):
        self.new_conversation()

    def get_last_assistant_text(self) -> str:
        if self._last_assistant_bubble:
            return self._last_assistant_bubble.get_text()
        return ""

    def reset(self):
        self.new_conversation()

    # ── Model switcher ────────────────────────────────────────────────────────

    def _on_model_pill_clicked(self):
        self._model_switcher.set_active(self._model_id)
        self._model_switcher.show_below(self._input_bar)

    def _on_model_selected(self, model_id: str):
        self._model_id = model_id
        self._model_label = self._label_for_id(model_id)
        self._input_bar.set_model_label(self._model_label)
        log.debug(f"ChatTab: model changed to {model_id}")

    @staticmethod
    def _label_for_id(mid: str) -> str:
        for m in MODELS:
            if m["id"] == mid:
                return m["label"]
        return mid

    # ── Chips ─────────────────────────────────────────────────────────────────

    def _on_chip(self, chip_text: str):
        self._remove_state_widgets()
        prompt = CHIP_PROMPTS.get(chip_text, chip_text)
        self._input_bar.focus_input()
        self._input_bar._input.setPlainText(prompt)

    # ── Helpers ───────────────────────────────────────────────────────────────

    def _insert_message_widget(self, w: QWidget):
        idx = self._msg_v.count() - 1
        self._msg_v.insertWidget(idx, w)
        self._message_widgets.append(w)

    def _clear_messages(self):
        self._message_widgets.clear()
        while self._msg_v.count() > 1:
            item = self._msg_v.takeAt(0)
            if item.widget():
                item.widget().deleteLater()

    def _remove_state_widgets(self):
        for i in range(self._msg_v.count() - 1, -1, -1):
            item = self._msg_v.itemAt(i)
            if item and item.widget():
                w = item.widget()
                if isinstance(w, (_EmptyState, _NoKeyState)):
                    self._msg_v.removeItem(item)
                    w.deleteLater()

    def _scroll_to_bottom(self):
        QTimer.singleShot(50, self._do_scroll)

    def _do_scroll(self):
        try:
            if self._scroll and not self._scroll.isHidden():
                self._scroll.verticalScrollBar().setValue(
                    self._scroll.verticalScrollBar().maximum()
                )
        except RuntimeError:
            pass  # Widget was deleted

    @staticmethod
    def _friendly_error(raw: str) -> str:
        r = raw.lower()
        if "rate limit" in r:
            return ERROR_RATE_LIMIT
        if "auth" in r or "api key" in r or "invalid" in r:
            return ERROR_AUTH
        if "connection" in r or "network" in r:
            return "Connection error — check your network."
        return ERROR_GENERIC


# ── Empty state widget ────────────────────────────────────────────────────────

class _EmptyState(QWidget):
    chip_clicked = pyqtSignal(str)

    def __init__(self, parent=None):
        super().__init__(parent)
        self.setAttribute(Qt.WA_StyledBackground, True)
        self.setStyleSheet("background: transparent;")

        v = QVBoxLayout(self)
        v.setAlignment(Qt.AlignCenter)
        v.setSpacing(T.SPACING["lg"])

        logo = QLabel("C")
        logo.setFixedSize(48, 48)
        logo.setAlignment(Qt.AlignCenter)
        logo.setStyleSheet(
            f"background: {T.BRAND_PRIMARY}; color: {T.TEXT_ON_BRAND}; "
            f"border-radius: {T.RADIUS['2xl']}px; font-size: 22px; font-weight: 700;"
        )
        logo_row = QHBoxLayout()
        logo_row.addStretch()
        logo_row.addWidget(logo)
        logo_row.addStretch()
        v.addLayout(logo_row)

        name = _display_name()
        greeting = QLabel(f"{_greeting()}, {name}." if name else f"{_greeting()}.")
        greeting.setFont(QFont(T.FONT_FAMILY, T.FONT_SIZES["2xl"], T.FONT_WEIGHTS["medium"]))
        greeting.setStyleSheet(f"color: {T.TEXT_PRIMARY}; background: transparent;")
        greeting.setAlignment(Qt.AlignCenter)
        v.addWidget(greeting)

        sub = QLabel(GREETING_SUBTITLE)
        sub.setFont(QFont(T.FONT_FAMILY, T.FONT_SIZES["lg"]))
        sub.setStyleSheet(f"color: {T.TEXT_SECONDARY}; background: transparent;")
        sub.setAlignment(Qt.AlignCenter)
        v.addWidget(sub)

        v.addSpacing(T.SPACING["lg"])

        chips_row = QHBoxLayout()
        chips_row.setSpacing(T.SPACING["sm"])
        chips_row.addStretch()
        for text in (CHIP_EMAIL, CHIP_RESEARCH, CHIP_CODE, CHIP_ANALYZE):
            chip = _Chip(text)
            chip.clicked.connect(lambda _, t=text: self.chip_clicked.emit(t))
            chips_row.addWidget(chip)
        chips_row.addStretch()
        v.addLayout(chips_row)


class _Chip(QPushButton):
    def __init__(self, text: str, parent=None):
        super().__init__(text, parent)
        self.setCursor(Qt.PointingHandCursor)
        self.setFont(QFont(T.FONT_FAMILY, T.FONT_SIZES["base"]))
        self.setStyleSheet(
            f"QPushButton {{ background: {T.BG_ELEVATED}; color: {T.TEXT_SECONDARY}; "
            f"  border: 1px solid {T.BG_BORDER}; "
            f"  border-radius: {T.RADIUS['full']}px; padding: {T.SPACING['sm']}px {T.SPACING['lg']}px; }}"
            f"QPushButton:hover {{ border-color: {T.BRAND_MUTED}; color: {T.TEXT_PRIMARY}; }}"
        )


# ── No API key state ──────────────────────────────────────────────────────────

class _NoKeyState(QWidget):
    go_to_settings = pyqtSignal()

    def __init__(self, parent=None):
        super().__init__(parent)
        self.setAttribute(Qt.WA_StyledBackground, True)
        self.setStyleSheet("background: transparent;")

        v = QVBoxLayout(self)
        v.setAlignment(Qt.AlignCenter)
        v.setSpacing(T.SPACING["md"])

        heading = QLabel(NO_API_KEY_HEADING)
        heading.setFont(QFont(T.FONT_FAMILY, T.FONT_SIZES["2xl"], T.FONT_WEIGHTS["semibold"]))
        heading.setStyleSheet(f"color: {T.TEXT_PRIMARY}; background: transparent;")
        heading.setAlignment(Qt.AlignCenter)
        v.addWidget(heading)

        body = QLabel(NO_API_KEY_BODY)
        body.setFont(QFont(T.FONT_FAMILY, T.FONT_SIZES["md"]))
        body.setStyleSheet(f"color: {T.TEXT_SECONDARY}; background: transparent;")
        body.setAlignment(Qt.AlignCenter)
        v.addWidget(body)

        btn = QPushButton(NO_API_KEY_BTN)
        btn.setFixedHeight(40)
        btn.setCursor(Qt.PointingHandCursor)
        btn.setFont(QFont(T.FONT_FAMILY, T.FONT_SIZES["md"], T.FONT_WEIGHTS["medium"]))
        btn.setStyleSheet(
            f"QPushButton {{ background: {T.BRAND_PRIMARY}; color: {T.TEXT_ON_BRAND}; "
            f"  border: none; border-radius: {T.RADIUS['lg']}px; padding: 0 {T.SPACING['xl']}px; }}"
            f"QPushButton:hover {{ background: {T.BRAND_HOVER}; }}"
        )
        btn.clicked.connect(self.go_to_settings)

        btn_row = QHBoxLayout()
        btn_row.addStretch()
        btn_row.addWidget(btn)
        btn_row.addStretch()
        v.addLayout(btn_row)


# ── Error banner ──────────────────────────────────────────────────────────────

class _ErrorBanner(QWidget):
    retry_clicked = pyqtSignal()

    def __init__(self, parent=None):
        super().__init__(parent)
        self.setAttribute(Qt.WA_StyledBackground, True)
        self.setStyleSheet(
            f"background: {T.ERROR_BG}; border-top: 1px solid {T.ERROR};"
        )

        row = QHBoxLayout(self)
        row.setContentsMargins(T.SPACING["xl"], T.SPACING["sm"], T.SPACING["xl"], T.SPACING["sm"])
        row.setSpacing(T.SPACING["lg"])

        self._msg = QLabel()
        self._msg.setFont(QFont(T.FONT_FAMILY, T.FONT_SIZES["sm"]))
        self._msg.setStyleSheet(f"color: {T.ERROR}; background: transparent;")
        row.addWidget(self._msg, 1)

        retry = QPushButton(ERROR_RETRY)
        retry.setFixedHeight(28)
        retry.setCursor(Qt.PointingHandCursor)
        retry.setStyleSheet(
            f"QPushButton {{ background: transparent; color: {T.ERROR}; "
            f"  border: 1px solid {T.ERROR}; border-radius: {T.RADIUS['md']}px; "
            f"  padding: 0 12px; font-size: 12px; }}"
            f"QPushButton:hover {{ background: {T.ERROR}; color: {T.BG_BASE}; }}"
        )
        retry.clicked.connect(self.retry_clicked)
        row.addWidget(retry)

    def show_error(self, message: str):
        self._msg.setText(message)
        self.show()

    def reset(self):
        self.hide()
