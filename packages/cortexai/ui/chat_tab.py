import logging
from datetime import datetime
from typing import Dict, List, Optional

from PyQt5.QtWidgets import (
    QWidget, QVBoxLayout, QHBoxLayout, QPushButton, QLabel,
    QTextEdit, QPlainTextEdit,
)
from PyQt5.QtGui import QFont, QTextCursor
from PyQt5.QtCore import QShortcut, QKeySequence

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

        self._chat_display = QTextEdit()
        self._chat_display.setReadOnly(True)
        self._chat_display.setFont(QFont("Segoe UI", 12))
        self._chat_display.setStyleSheet(
            "background:#1e1e1e; color:#d4d4d4; border:1px solid #444; border-radius:4px; padding:8px;"
        )
        layout.addWidget(self._chat_display)

        self._typing_label = QLabel("")
        self._typing_label.setStyleSheet("color:#888; font-size:10px; padding:2px 4px;")
        layout.addWidget(self._typing_label)

        input_row = QHBoxLayout()
        self._input_box = QPlainTextEdit()
        self._input_box.setPlaceholderText("Type your message… (Ctrl+Enter to send)")
        self._input_box.setMaximumHeight(80)
        self._input_box.setStyleSheet(
            "background:#252526; color:#d4d4d4; border:1px solid #444; border-radius:4px; padding:6px;"
        )

        btn_col = QVBoxLayout()
        self._send_btn = QPushButton("Send")
        self._send_btn.setMinimumWidth(80)
        self._send_btn.setStyleSheet(
            "QPushButton { background:#0e639c; color:white; border-radius:4px; padding:6px 12px; }"
            "QPushButton:hover { background:#1177bb; }"
            "QPushButton:disabled { background:#444; color:#888; }"
        )
        self._send_btn.clicked.connect(self._send_message)

        clear_btn = QPushButton("Clear")
        clear_btn.setMinimumWidth(80)
        clear_btn.setStyleSheet(
            "QPushButton { background:#3a3a3a; color:#d4d4d4; border-radius:4px; padding:6px 12px; }"
            "QPushButton:hover { background:#505050; }"
        )
        clear_btn.clicked.connect(self.clear_chat)

        btn_col.addWidget(self._send_btn)
        btn_col.addWidget(clear_btn)
        input_row.addWidget(self._input_box)
        input_row.addLayout(btn_col)
        layout.addLayout(input_row)

        shortcut = QShortcut(QKeySequence("Ctrl+Return"), self)
        shortcut.activated.connect(self._send_message)

        self._append_system("CortexAI is ready. Type a message to start chatting.")
        if not self._ai_core.anthropic_client.ready:
            self._append_system(
                "⚠ No API key detected. Enter your Anthropic API key in the sidebar to enable chat."
            )

    def _send_message(self):
        text = self._input_box.toPlainText().strip()
        if not text or self._worker is not None:
            return
        self._input_box.clear()
        self._append_message("You", text, "#4CAF50")
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
        self._append_message("CortexAI", reply, "#569CD6")

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
        self._append_system(f"⚠ Error: {error}")

    def _on_worker_done(self):
        self._worker = None
        self._set_input_enabled(True)
        self._typing_label.setText("")

    def _set_input_enabled(self, enabled: bool):
        self._input_box.setEnabled(enabled)
        self._send_btn.setEnabled(enabled)

    def _append_message(self, sender: str, text: str, color: str):
        timestamp = datetime.now().strftime("%H:%M:%S")
        self._chat_display.append(
            f'<span style="color:{color}; font-weight:bold;">[{timestamp}] {sender}:</span>'
        )
        escaped = text.replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;")
        self._chat_display.append(
            f'<span style="color:#d4d4d4;">{escaped.replace(chr(10), "<br>")}</span><br>'
        )
        self._chat_display.moveCursor(QTextCursor.End)

    def _append_system(self, text: str):
        self._chat_display.append(
            f'<span style="color:#888; font-style:italic;">{text}</span><br>'
        )
        self._chat_display.moveCursor(QTextCursor.End)

    def clear_chat(self):
        self._messages.clear()
        self._chat_display.clear()
        self._ai_core.clear_history()
        self._append_system("Chat cleared. Starting a new conversation.")
