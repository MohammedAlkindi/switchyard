import logging
from datetime import datetime
from typing import Dict, List, Optional

from PyQt5.QtWidgets import (
    QWidget, QVBoxLayout, QHBoxLayout, QPushButton, QLabel,
    QTextEdit, QPlainTextEdit, QShortcut,
)
from PyQt5.QtGui import QFont, QTextCursor, QKeySequence
from PyQt5.QtCore import Qt

from clients.anthropic_client import AnthropicClient, ChatWorker
from core.conversation import ConversationEntry

log = logging.getLogger("CortexAI")


class ChatTab(QWidget):
    SYSTEM_PROMPT = (
        "You are CortexAI, a helpful, accurate, and concise AI assistant built into a "
        "desktop application. Respond clearly and use markdown formatting where appropriate."
    )

    def __init__(self, ai_core, parent=None):
        super().__init__(parent)
        self._ai_core = ai_core
        self._messages: List[Dict[str, str]] = []
        self._worker: Optional[ChatWorker] = None
        self._setup_ui()

    def _setup_ui(self):
        layout = QVBoxLayout(self)
        layout.setContentsMargins(0, 0, 0, 0)
        layout.setSpacing(0)

        # ── Header ────────────────────────────────────────────────────────
        header = QWidget()
        header.setFixedHeight(48)
        header.setAttribute(Qt.WA_StyledBackground, True)
        header.setStyleSheet("background:#0F0F0F; border-bottom:1px solid #1C1C1C;")
        h_row = QHBoxLayout(header)
        h_row.setContentsMargins(22, 0, 22, 0)
        title = QLabel("Chat")
        title.setStyleSheet("color:#E2E2E2; font-size:14px; font-weight:600; background:transparent;")
        h_row.addWidget(title)
        h_row.addStretch()
        layout.addWidget(header)

        # ── Message display ───────────────────────────────────────────────
        self._chat_display = QTextEdit()
        self._chat_display.setReadOnly(True)
        self._chat_display.setFont(QFont("Segoe UI", 13))
        self._chat_display.setStyleSheet(
            "QTextEdit { background:#0B0B0B; color:#C8C8C8; border:none; padding:20px 28px; }"
            "QScrollBar:vertical { background:transparent; width:6px; }"
            "QScrollBar::handle:vertical { background:#252525; border-radius:3px; min-height:30px; }"
            "QScrollBar::handle:vertical:hover { background:#333; }"
            "QScrollBar::add-line:vertical, QScrollBar::sub-line:vertical { height:0; }"
        )
        layout.addWidget(self._chat_display, 1)

        # ── Typing indicator ──────────────────────────────────────────────
        self._typing_label = QLabel("")
        self._typing_label.setStyleSheet(
            "color:#444; font-size:12px; padding:0 28px 6px 28px; "
            "background:#0B0B0B; font-style:italic;"
        )
        layout.addWidget(self._typing_label)

        # ── Input area ────────────────────────────────────────────────────
        input_wrap = QWidget()
        input_wrap.setAttribute(Qt.WA_StyledBackground, True)
        input_wrap.setStyleSheet("background:#0F0F0F; border-top:1px solid #1C1C1C;")
        input_v = QVBoxLayout(input_wrap)
        input_v.setContentsMargins(16, 12, 16, 12)
        input_v.setSpacing(8)

        self._input_box = QPlainTextEdit()
        self._input_box.setPlaceholderText("Write a message…  (Ctrl+Enter to send)")
        self._input_box.setMaximumHeight(100)
        self._input_box.setMinimumHeight(56)
        self._input_box.setStyleSheet(
            "QPlainTextEdit { background:#161616; color:#E2E2E2; "
            "    border:1px solid #252525; border-radius:8px; "
            "    padding:10px 14px; font-size:13px; font-family:'Segoe UI'; }"
            "QPlainTextEdit:focus { border-color:#5E6AD2; }"
        )
        input_v.addWidget(self._input_box)

        btn_row = QHBoxLayout()
        btn_row.setSpacing(8)

        clear_btn = QPushButton("Clear")
        clear_btn.setFixedHeight(32)
        clear_btn.setStyleSheet(
            "QPushButton { background:transparent; color:#555; border:1px solid #252525; "
            "    border-radius:6px; padding:0 14px; font-size:12px; }"
            "QPushButton:hover { background:#1A1A1A; color:#CCC; border-color:#333; }"
        )
        clear_btn.clicked.connect(self.clear_chat)

        hint = QLabel("Ctrl+Enter")
        hint.setStyleSheet("color:#2E2E2E; font-size:11px;")

        self._send_btn = QPushButton("Send")
        self._send_btn.setFixedHeight(32)
        self._send_btn.setStyleSheet(
            "QPushButton { background:#5E6AD2; color:white; border:none; "
            "    border-radius:6px; padding:0 20px; font-size:13px; font-weight:500; }"
            "QPushButton:hover { background:#6B77DB; }"
            "QPushButton:pressed { background:#5059C9; }"
            "QPushButton:disabled { background:#1C1A2E; color:#3E3A5E; }"
        )
        self._send_btn.clicked.connect(self._send_message)

        btn_row.addWidget(clear_btn)
        btn_row.addStretch()
        btn_row.addWidget(hint)
        btn_row.addSpacing(8)
        btn_row.addWidget(self._send_btn)

        input_v.addLayout(btn_row)
        layout.addWidget(input_wrap)

        shortcut = QShortcut(QKeySequence("Ctrl+Return"), self)
        shortcut.activated.connect(self._send_message)

        self._append_system("CortexAI is ready. Type a message to start chatting.")
        if not self._ai_core.anthropic_client.ready:
            self._append_system(
                "No API key detected — enter your Anthropic API key in the sidebar."
            )

    # ── Messaging ─────────────────────────────────────────────────────────

    def _send_message(self):
        text = self._input_box.toPlainText().strip()
        if not text or self._worker is not None:
            return
        self._input_box.clear()
        self._append_message("You", text, is_user=True)
        self._messages.append({"role": "user", "content": text})
        self._set_input_enabled(False)
        self._typing_label.setText("CortexAI is thinking…")

        self._worker = ChatWorker(
            self._ai_core.anthropic_client,
            list(self._messages),
            self.SYSTEM_PROMPT,
            parent=self,
        )
        self._worker.response_ready.connect(self._on_response)
        self._worker.error_occurred.connect(self._on_error)
        self._worker.finished.connect(self._on_worker_done)
        self._worker.start()

    def _on_response(self, reply: str):
        self._messages.append({"role": "assistant", "content": reply})
        self._append_message("CortexAI", reply, is_user=False)

        if len(self._messages) >= 2:
            user_msg = self._messages[-2].get("content", "")
            entry = ConversationEntry(
                timestamp=datetime.now(),
                prompt=user_msg,
                response=reply,
                model_used=AnthropicClient.DEFAULT_MODEL,
            )
            self._ai_core.add_to_history(entry)
            self._ai_core.compliance.record("user", "chat", "anthropic_api")

    def _on_error(self, error: str):
        self._append_system(f"Error: {error}")

    def _on_worker_done(self):
        self._worker = None
        self._set_input_enabled(True)
        self._typing_label.setText("")

    def _set_input_enabled(self, enabled: bool):
        self._input_box.setEnabled(enabled)
        self._send_btn.setEnabled(enabled)

    def _append_message(self, sender: str, text: str, is_user: bool = False):
        timestamp = datetime.now().strftime("%H:%M")
        color = "#26B5A7" if is_user else "#5E6AD2"
        escaped = (
            text.replace("&", "&amp;")
                .replace("<", "&lt;")
                .replace(">", "&gt;")
                .replace(chr(10), "<br>")
        )
        html = (
            f'<div style="margin-bottom:20px;">'
            f'  <div style="margin-bottom:6px;">'
            f'    <span style="color:{color}; font-weight:600; font-size:13px;">{sender}</span>'
            f'    <span style="color:#333; font-size:11px; margin-left:10px;">{timestamp}</span>'
            f'  </div>'
            f'  <div style="color:#BEBEBE; font-size:13px; line-height:1.65;">{escaped}</div>'
            f'</div>'
        )
        self._chat_display.append(html)
        self._chat_display.moveCursor(QTextCursor.End)

    def _append_system(self, text: str):
        html = (
            f'<div style="color:#3A3A3A; font-size:12px; font-style:italic; '
            f'margin-bottom:16px;">{text}</div>'
        )
        self._chat_display.append(html)
        self._chat_display.moveCursor(QTextCursor.End)

    def clear_chat(self):
        self._messages.clear()
        self._chat_display.clear()
        self._ai_core.clear_history()
        self._append_system("Chat cleared. Starting a new conversation.")
