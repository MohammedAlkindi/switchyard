import logging
from typing import Callable, Dict, List, Tuple

from PyQt5.QtWidgets import QWidget
from PyQt5.QtGui import QKeySequence
from PyQt5.QtCore import Qt

log = logging.getLogger("CortexAI")

# (key_sequence_str, description, action_name)
SHORTCUT_MAP: List[Tuple[str, str]] = [
    ("Ctrl+N",       "New conversation"),
    ("Ctrl+K",       "Open model switcher"),
    ("Ctrl+/",       "Show all shortcuts"),
    ("Ctrl+,",       "Open settings"),
    ("Ctrl+L",       "Clear conversation"),
    ("Ctrl+E",       "Export conversation"),
    ("Ctrl+F",       "Search in conversation"),
    ("Ctrl+1",       "Switch to Chat"),
    ("Ctrl+2",       "Switch to Analytics"),
    ("Ctrl+3",       "Switch to Docs"),
    ("Ctrl+4",       "Switch to Plugins"),
    ("Ctrl+5",       "Switch to Settings"),
    ("Ctrl+Shift+C", "Copy last response"),
    ("Escape",       "Stop / close"),
]


class ShortcutManager:
    """Registers global keyboard shortcuts on a host QWidget."""

    def __init__(self, host: QWidget):
        self._host = host
        self._actions: Dict[str, Callable] = {}

    def register(self, key: str, callback: Callable) -> None:
        from PyQt5.QtWidgets import QShortcut
        sc = QShortcut(QKeySequence(key), self._host)
        sc.setContext(Qt.ApplicationShortcut)
        sc.activated.connect(callback)
        self._actions[key] = callback
        log.debug(f"Shortcut registered: {key}")

    def register_all(self, bindings: Dict[str, Callable]) -> None:
        for key, cb in bindings.items():
            self.register(key, cb)
