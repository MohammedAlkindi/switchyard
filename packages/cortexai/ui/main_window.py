import logging
import platform
import sys

from PyQt5.QtWidgets import (
    QMainWindow, QWidget, QHBoxLayout, QVBoxLayout, QLabel,
    QStackedWidget, QSplashScreen, QApplication, QProgressBar,
    QSystemTrayIcon, QMenu, QShortcut,
)
from PyQt5.QtGui import QColor, QFont, QPixmap, QPainter, QKeySequence
from PyQt5.QtCore import Qt, QRect

import ui.theme as T
from core.ai_core import AICore
from core.shortcuts import ShortcutManager
from ui.components.title_bar import TitleBar
from ui.components.sidebar import Sidebar
from ui.tabs.chat_tab import ChatTab
from ui.tabs.analytics_tab import AnalyticsTab
from ui.tabs.settings_tab import SettingsTab
from ui.components.toast import show_toast

try:
    from ui.docs_tab import DocumentationTab
    HAS_DOCS = True
except ImportError:
    HAS_DOCS = False

log = logging.getLogger("CortexAI")

_NAV_KEYS = ["chat", "analytics", "docs", "plugins", "settings"]


class SplashScreen(QSplashScreen):
    def __init__(self):
        px = QPixmap(420, 260)
        px.fill(QColor(T.BG_BASE))
        super().__init__(px)
        self.setWindowFlag(Qt.FramelessWindowHint)

        self._progress = QProgressBar(self)
        self._progress.setGeometry(30, 222, 360, 4)
        self._progress.setStyleSheet(
            f"QProgressBar {{ background: {T.BG_ELEVATED}; border-radius: 2px; border: none; }}"
            f"QProgressBar::chunk {{ background: {T.BRAND_PRIMARY}; border-radius: 2px; }}"
        )
        self._progress.setTextVisible(False)
        self._progress.setMaximum(100)
        self._progress.setValue(0)

        p = QPainter(px)
        p.setRenderHint(QPainter.Antialiasing)
        box = QRect(186, 68, 48, 48)
        p.setBrush(QColor(T.BRAND_PRIMARY))
        p.setPen(Qt.NoPen)
        p.drawRoundedRect(box, T.RADIUS["lg"], T.RADIUS["lg"])
        p.setPen(QColor(T.TEXT_ON_BRAND))
        p.setFont(QFont(T.FONT_FAMILY, 22, QFont.Bold))
        p.drawText(box, Qt.AlignCenter, "C")
        p.setPen(QColor(T.TEXT_PRIMARY))
        p.setFont(QFont(T.FONT_FAMILY, 20, T.FONT_WEIGHTS["normal"]))
        p.drawText(QRect(0, 126, 420, 36), Qt.AlignCenter, "CortexAI")
        p.setPen(QColor(T.TEXT_TERTIARY))
        p.setFont(QFont(T.FONT_FAMILY, 10))
        p.drawText(QRect(0, 166, 420, 24), Qt.AlignCenter, "AI-powered workspace")
        p.end()
        self.setPixmap(px)

    def set_progress(self, value: int):
        self._progress.setValue(value)
        QApplication.processEvents()


class MainWindow(QMainWindow):
    def __init__(self):
        super().__init__()
        self.setWindowTitle("CortexAI")
        self.setWindowFlags(Qt.FramelessWindowHint)
        self.resize(1280, 820)
        self.setMinimumSize(1100, 700)
        self.setAttribute(Qt.WA_TranslucentBackground, False)
        self.setStyleSheet(f"QMainWindow {{ background: {T.BG_BASE}; }}")

        self._ai_core = AICore(parent=self)
        self._ai_core.status_update.connect(self._on_status_update)

        self._setup_ui()
        self._setup_shortcuts()
        self._setup_tray()
        self._load_conversations()

        log.info("MainWindow ready.")

    # ── UI layout ─────────────────────────────────────────────────────────────

    def _setup_ui(self):
        root_widget = QWidget()
        self.setCentralWidget(root_widget)
        root_v = QVBoxLayout(root_widget)
        root_v.setContentsMargins(0, 0, 0, 0)
        root_v.setSpacing(0)

        # Custom title bar
        self._title_bar = TitleBar()
        root_v.addWidget(self._title_bar)

        # Separator
        sep = QWidget()
        sep.setFixedHeight(1)
        sep.setStyleSheet(f"background: {T.BG_BORDER};")
        root_v.addWidget(sep)

        # Body: sidebar + main content
        body = QWidget()
        body_h = QHBoxLayout(body)
        body_h.setContentsMargins(0, 0, 0, 0)
        body_h.setSpacing(0)

        # Sidebar
        self._sidebar = Sidebar()
        self._sidebar.nav_changed.connect(self._on_nav_changed)
        self._sidebar.new_chat_requested.connect(self._on_new_chat)
        self._sidebar.conversation_selected.connect(self._on_conv_selected)
        self._sidebar.conversation_deleted.connect(self._on_conv_deleted)
        self._sidebar.conversation_renamed.connect(self._on_conv_renamed)
        # Keep legacy compat for any residual wiring
        self._sidebar.api_key_changed.connect(self._on_api_key_change)
        body_h.addWidget(self._sidebar)

        # Separator
        v_sep = QWidget()
        v_sep.setFixedWidth(1)
        v_sep.setStyleSheet(f"background: {T.BG_BORDER};")
        body_h.addWidget(v_sep)

        # Stacked content
        self._stack = QStackedWidget()
        self._stack.setStyleSheet(f"background: {T.BG_BASE};")

        self._chat_tab      = ChatTab(self._ai_core)
        self._analytics_tab = AnalyticsTab(self._ai_core)
        self._settings_tab  = SettingsTab(self._ai_core)

        self._chat_tab.open_settings_requested.connect(lambda: self._on_nav_changed("settings"))
        self._chat_tab.conversation_updated.connect(self._on_conv_updated)
        self._settings_tab.api_key_changed.connect(self._on_api_key_change)

        self._stack.addWidget(self._chat_tab)       # 0 – chat
        self._stack.addWidget(self._analytics_tab)  # 1 – analytics

        if HAS_DOCS:
            from ui.docs_tab import DocumentationTab
            self._docs_tab = DocumentationTab()
            self._stack.addWidget(self._docs_tab)   # 2 – docs
        else:
            placeholder = _Placeholder("Docs")
            self._stack.addWidget(placeholder)      # 2 – docs

        placeholder_plugins = _Placeholder("Plugins")
        self._stack.addWidget(placeholder_plugins)  # 3 – plugins

        self._stack.addWidget(self._settings_tab)   # 4 – settings

        body_h.addWidget(self._stack, 1)
        root_v.addWidget(body, 1)

    # ── Keyboard shortcuts ────────────────────────────────────────────────────

    def _setup_shortcuts(self):
        self._shortcuts = ShortcutManager(self)
        self._shortcuts.register_all({
            "Ctrl+N":       self._on_new_chat,
            "Ctrl+,":       lambda: self._on_nav_changed("settings"),
            "Ctrl+1":       lambda: self._on_nav_changed("chat"),
            "Ctrl+2":       lambda: self._on_nav_changed("analytics"),
            "Ctrl+3":       lambda: self._on_nav_changed("docs"),
            "Ctrl+4":       lambda: self._on_nav_changed("plugins"),
            "Ctrl+5":       lambda: self._on_nav_changed("settings"),
            "Ctrl+L":       self._chat_tab.clear_chat,
            "Ctrl+Shift+C": self._copy_last,
            "Ctrl+K":       self._chat_tab._on_model_pill_clicked,
            "Ctrl+/":       self._show_shortcuts_help,
        })

    # ── System tray ───────────────────────────────────────────────────────────

    def _setup_tray(self):
        self._tray = QSystemTrayIcon(self)
        menu = QMenu()
        menu.setStyleSheet(
            f"QMenu {{ background: {T.BG_ELEVATED}; border: 1px solid {T.BG_BORDER}; "
            f"color: {T.TEXT_PRIMARY}; font-size: 13px; padding: 4px; }}"
            f"QMenu::item {{ padding: 6px 20px; border-radius: {T.RADIUS['sm']}px; }}"
            f"QMenu::item:selected {{ background: {T.BG_OVERLAY}; }}"
        )
        menu.addAction("Show", self.show)
        menu.addAction("Exit", QApplication.quit)
        self._tray.setContextMenu(menu)
        self._tray.show()

    # ── Conversation management ───────────────────────────────────────────────

    def _load_conversations(self):
        convs = self._chat_tab._store.list_recent()
        self._sidebar.load_conversations(convs)
        ok = self._ai_core.anthropic_client.ready
        self._sidebar.set_key_status(ok)
        from ui.strings import DEFAULT_MODEL_ID
        self._sidebar.set_model_name(DEFAULT_MODEL_ID)

    def _on_new_chat(self):
        self._chat_tab.new_conversation()
        self._sidebar.set_active_conversation("")
        self._on_nav_changed("chat")

    def _on_conv_selected(self, cid: str):
        self._chat_tab.load_conversation(cid)
        self._on_nav_changed("chat")

    def _on_conv_deleted(self, cid: str):
        self._chat_tab._store.delete(cid)
        if self._chat_tab._conv_id == cid:
            self._chat_tab.new_conversation()

    def _on_conv_renamed(self, cid: str, title: str):
        self._chat_tab._store.rename(cid, title)

    def _on_conv_updated(self, conv: dict):
        self._sidebar.add_or_update_conversation(conv)
        self._sidebar.set_active_conversation(conv["id"])

    # ── Nav ───────────────────────────────────────────────────────────────────

    def _on_nav_changed(self, key: str):
        idx = _NAV_KEYS.index(key) if key in _NAV_KEYS else 0
        self._stack.setCurrentIndex(idx)
        self._sidebar.set_active_nav(key)
        log.debug(f"Navigated to: {key}")

    # ── Misc slots ────────────────────────────────────────────────────────────

    def _on_status_update(self, message: str, level: str):
        log.log(
            logging.INFO    if level == "info"    else
            logging.WARNING if level == "warning" else
            logging.ERROR,
            message,
        )

    def _on_api_key_change(self, key: str):
        self._ai_core.anthropic_client.set_api_key(key)
        ok = self._ai_core.anthropic_client.ready
        self._sidebar.set_key_status(ok)
        show_toast("API key saved" if ok else "API key cleared", "success" if ok else "info", self)

    def _copy_last(self):
        text = self._chat_tab.get_last_assistant_text()
        if text:
            QApplication.clipboard().setText(text)
            show_toast("Copied to clipboard", "success", self)

    def _show_shortcuts_help(self):
        from ui.strings import SHORTCUT_DEFS, SHORTCUTS_TITLE
        from PyQt5.QtWidgets import QDialog, QVBoxLayout, QGridLayout, QLabel, QPushButton
        dlg = QDialog(self)
        dlg.setWindowTitle(SHORTCUTS_TITLE)
        dlg.setMinimumWidth(460)
        dlg.setStyleSheet(
            f"QDialog {{ background: {T.BG_ELEVATED}; color: {T.TEXT_PRIMARY}; }}"
            f"QLabel {{ background: transparent; }}"
        )
        v = QVBoxLayout(dlg)
        v.setContentsMargins(T.SPACING["2xl"], T.SPACING["2xl"], T.SPACING["2xl"], T.SPACING["2xl"])
        v.setSpacing(T.SPACING["lg"])

        title = QLabel(SHORTCUTS_TITLE)
        title.setFont(QFont(T.FONT_FAMILY, T.FONT_SIZES["lg"], T.FONT_WEIGHTS["semibold"]))
        title.setStyleSheet(f"color: {T.TEXT_PRIMARY};")
        v.addWidget(title)

        grid = QGridLayout()
        grid.setSpacing(T.SPACING["sm"])
        for i, (keys, desc) in enumerate(SHORTCUT_DEFS):
            k = QLabel(keys)
            k.setFont(QFont("Consolas", T.FONT_SIZES["sm"]))
            k.setStyleSheet(
                f"background: {T.BG_OVERLAY}; color: {T.BRAND_PRIMARY}; "
                f"border-radius: {T.RADIUS['sm']}px; padding: 2px 6px;"
            )
            d = QLabel(desc)
            d.setFont(QFont(T.FONT_FAMILY, T.FONT_SIZES["base"]))
            d.setStyleSheet(f"color: {T.TEXT_SECONDARY};")
            grid.addWidget(k, i, 0)
            grid.addWidget(d, i, 1)
        v.addLayout(grid)

        close_btn = QPushButton("Close")
        close_btn.setFixedHeight(36)
        close_btn.setCursor(Qt.PointingHandCursor)
        close_btn.setStyleSheet(
            f"QPushButton {{ background: {T.BG_OVERLAY}; color: {T.TEXT_PRIMARY}; "
            f"  border: none; border-radius: {T.RADIUS['md']}px; }}"
            f"QPushButton:hover {{ background: {T.BG_BORDER}; }}"
        )
        close_btn.clicked.connect(dlg.accept)
        v.addWidget(close_btn)
        dlg.exec_()


class _Placeholder(QWidget):
    def __init__(self, name: str, parent=None):
        super().__init__(parent)
        self.setStyleSheet(f"background: {T.BG_BASE};")
        v = QVBoxLayout(self)
        v.setAlignment(Qt.AlignCenter)
        lbl = QLabel(f"{name} — Coming soon")
        lbl.setFont(QFont(T.FONT_FAMILY, T.FONT_SIZES["xl"]))
        lbl.setStyleSheet(f"color: {T.TEXT_TERTIARY}; background: transparent;")
        lbl.setAlignment(Qt.AlignCenter)
        v.addWidget(lbl)
