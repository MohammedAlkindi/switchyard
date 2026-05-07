from pathlib import Path

from PyQt5.QtWidgets import QWidget, QVBoxLayout, QHBoxLayout, QLabel, QTextEdit
from PyQt5.QtGui import QFont
from PyQt5.QtCore import Qt


class DocumentationTab(QWidget):
    def __init__(self, parent=None):
        super().__init__(parent)
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
        title = QLabel("Documentation")
        title.setStyleSheet("color:#E2E2E2; font-size:14px; font-weight:600; background:transparent;")
        h_row.addWidget(title)
        h_row.addStretch()
        layout.addWidget(header)

        # ── Content ───────────────────────────────────────────────────────
        self._display = QTextEdit()
        self._display.setReadOnly(True)
        self._display.setFont(QFont("Segoe UI", 13))
        self._display.setStyleSheet(
            "QTextEdit { background:#0B0B0B; color:#ABABAB; border:none; "
            "            padding:28px 36px; font-size:13px; line-height:1.65; }"
            "QScrollBar:vertical { background:transparent; width:6px; }"
            "QScrollBar::handle:vertical { background:#252525; border-radius:3px; min-height:30px; }"
            "QScrollBar::handle:vertical:hover { background:#333; }"
            "QScrollBar::add-line:vertical, QScrollBar::sub-line:vertical { height:0; }"
        )
        self._display.setText(self._load_docs())
        layout.addWidget(self._display, 1)

    def _load_docs(self) -> str:
        doc_path = Path("docs/user_guide.txt")
        if doc_path.exists():
            try:
                return doc_path.read_text(encoding="utf-8")
            except Exception:
                pass
        return (
            "Welcome to CortexAI!\n\n"
            "Getting Started:\n"
            "  1. Type a message in the Chat tab and press Ctrl+Enter or click Send.\n"
            "  2. Check the Analytics tab for real-time system metrics.\n"
            "  3. Configure models in cortexai/configs/config.yaml.\n"
            "  4. Add plugins to the cortexai/plugins/ directory.\n\n"
            "Features:\n"
            "  - Sentiment analysis\n"
            "  - Text translation (en→fr by default)\n"
            "  - Text summarization\n"
            "  - Language detection\n"
            "  - Plugin system\n"
            "  - Audit/compliance logging\n"
            "  - Optional FastAPI REST server\n\n"
            "Place docs/user_guide.txt for custom documentation."
        )
