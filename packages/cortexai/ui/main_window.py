import logging
import platform
import sys
import time

from PyQt5.QtWidgets import (
    QMainWindow, QWidget, QHBoxLayout, QLabel, QTabWidget,
    QSplashScreen, QMenu, QFileDialog, QMessageBox,
    QProgressBar, QSystemTrayIcon, QStatusBar, QSplitter, QApplication,
)
from PyQt5.QtGui import QColor, QFont, QPixmap, QPainter
from PyQt5.QtCore import Qt

from core.ai_core import AICore
from ui.analytics_tab import AnalyticsTab
from ui.chat_tab import ChatTab
from ui.docs_tab import DocumentationTab
from ui.sidebar import Sidebar

log = logging.getLogger("CortexAI")


class SplashScreen(QSplashScreen):
    def __init__(self):
        px = QPixmap(400, 250)
        px.fill(QColor("#1e1e1e"))
        super().__init__(px)
        self.setWindowFlag(Qt.FramelessWindowHint)

        self._progress = QProgressBar(self)
        self._progress.setGeometry(20, 210, 360, 20)
        self._progress.setStyleSheet(
            "QProgressBar { background:#333; border-radius:4px; }"
            "QProgressBar::chunk { background:#0e639c; border-radius:4px; }"
        )
        self._progress.setMaximum(100)
        self._progress.setValue(0)

        painter = QPainter(px)
        painter.setPen(QColor("#d4d4d4"))
        painter.setFont(QFont("Segoe UI", 20, QFont.Bold))
        painter.drawText(px.rect(), Qt.AlignCenter, "CortexAI")
        painter.end()
        self.setPixmap(px)

    def set_progress(self, value: int):
        self._progress.setValue(value)
        QApplication.processEvents()


class MainWindow(QMainWindow):
    def __init__(self):
        super().__init__()
        self.setWindowTitle("CortexAI")
        self.resize(1200, 800)
        self.setStyleSheet(
            "background:#1e1e1e; color:#d4d4d4; font-family:'Segoe UI',Arial,sans-serif;"
        )

        self._ai_core = AICore(parent=self)
        self._ai_core.status_update.connect(self._on_status_update)

        self._setup_ui()
        self._setup_status_bar()
        self._setup_tray()
        self._setup_menu()

        log.info("MainWindow ready.")

    def _setup_ui(self):
        central = QWidget()
        self.setCentralWidget(central)
        root = QHBoxLayout(central)
        root.setContentsMargins(0, 0, 0, 0)
        root.setSpacing(0)

        self._sidebar = Sidebar()
        self._sidebar.model_changed.connect(self._on_model_change)
        self._sidebar.api_key_changed.connect(self._on_api_key_change)

        self._tabs = QTabWidget()
        self._tabs.setStyleSheet(
            "QTabWidget::pane { border:1px solid #333; }"
            "QTabBar::tab { background:#252526; color:#888; padding:6px 14px; }"
            "QTabBar::tab:selected { color:#fff; border-bottom:2px solid #0e639c; }"
        )

        self._chat_tab = ChatTab(self._ai_core)
        self._analytics_tab = AnalyticsTab(self._ai_core)
        self._docs_tab = DocumentationTab()

        self._tabs.addTab(self._chat_tab, "Chat")
        self._tabs.addTab(self._analytics_tab, "Analytics")
        self._tabs.addTab(self._docs_tab, "Docs")

        splitter = QSplitter(Qt.Horizontal)
        splitter.addWidget(self._sidebar)
        splitter.addWidget(self._tabs)
        splitter.setSizes([220, 980])
        root.addWidget(splitter)

    def _setup_status_bar(self):
        bar = QStatusBar()
        self.setStatusBar(bar)
        self._status_label = QLabel("Ready")
        bar.addPermanentWidget(self._status_label)

    def _setup_tray(self):
        self._tray = QSystemTrayIcon(self)
        menu = QMenu()
        menu.addAction("Show", self.show)
        menu.addAction("Exit", QApplication.quit)
        self._tray.setContextMenu(menu)
        self._tray.show()

    def _setup_menu(self):
        menubar = self.menuBar()
        menubar.setStyleSheet("background:#2d2d2d; color:#d4d4d4;")

        file_menu = menubar.addMenu("File")
        file_menu.addAction("Clear Chat", self._chat_tab.clear_chat)
        file_menu.addAction("Export Audit Log", self._export_audit)
        file_menu.addSeparator()
        file_menu.addAction("Exit", QApplication.quit)

        help_menu = menubar.addMenu("Help")
        help_menu.addAction("About", self._show_about)

    def _on_status_update(self, message: str, level: str):
        self._status_label.setText(message)
        log.log(
            logging.INFO if level == "info" else
            logging.WARNING if level == "warning" else
            logging.ERROR,
            message,
        )

    def _on_model_change(self, model_name: str):
        self._status_label.setText(f"Model: {model_name}")

    def _on_api_key_change(self, key: str):
        self._ai_core.anthropic_client.set_api_key(key)
        ok = self._ai_core.anthropic_client.ready
        self._sidebar.set_key_status(ok)
        self._status_label.setText("API key updated." if ok else "API key cleared.")

    def _export_audit(self):
        path, _ = QFileDialog.getSaveFileName(self, "Export Audit Log", "", "JSON Files (*.json)")
        if path:
            self._ai_core.compliance.export(path)
            QMessageBox.information(self, "Exported", f"Audit log saved to {path}")

    def _show_about(self):
        QMessageBox.about(
            self, "About CortexAI",
            "CortexAI v1.0\n\n"
            "A clean, modular AI chat platform.\n"
            f"Python {sys.version.split()[0]} | PyQt5\n"
            f"Platform: {platform.system()} {platform.release()}",
        )
