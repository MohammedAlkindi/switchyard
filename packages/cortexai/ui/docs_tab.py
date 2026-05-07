from pathlib import Path

from PyQt5.QtWidgets import QWidget, QVBoxLayout, QTextEdit
from PyQt5.QtGui import QFont


class DocumentationTab(QWidget):
    def __init__(self, parent=None):
        super().__init__(parent)
        layout = QVBoxLayout(self)

        self._display = QTextEdit()
        self._display.setReadOnly(True)
        self._display.setFont(QFont("Segoe UI", 11))
        self._display.setStyleSheet(
            "background:#1e1e1e; color:#d4d4d4; border:1px solid #444; border-radius:4px; padding:8px;"
        )
        self._display.setText(self._load_docs())
        layout.addWidget(self._display)

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
