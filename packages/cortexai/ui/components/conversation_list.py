import logging

from PyQt5.QtWidgets import (
    QWidget, QVBoxLayout, QHBoxLayout, QLabel, QPushButton,
    QScrollArea, QMenu, QInputDialog, QMessageBox,
)
from PyQt5.QtCore import Qt, pyqtSignal
from PyQt5.QtGui import QFont, QCursor

import ui.theme as T
from ui.strings import (
    SIDEBAR_RECENTS, SIDEBAR_NEW_CHAT, CONV_RENAME, CONV_DELETE, CONV_DELETE_MSG
)

log = logging.getLogger("CortexAI")


class ConversationList(QWidget):
    """Sidebar panel listing recent conversations."""

    new_chat_requested     = pyqtSignal()
    conversation_selected  = pyqtSignal(str)  # emits conversation id
    conversation_deleted   = pyqtSignal(str)
    conversation_renamed   = pyqtSignal(str, str)  # id, new_title

    def __init__(self, parent=None):
        super().__init__(parent)
        self.setAttribute(Qt.WA_StyledBackground, True)
        self.setStyleSheet(f"background: {T.BG_SURFACE};")
        self._active_id: str = ""
        self._items: dict[str, "_ConvItem"] = {}
        self._setup_ui()

    def _setup_ui(self):
        v = QVBoxLayout(self)
        v.setContentsMargins(0, 0, 0, 0)
        v.setSpacing(0)

        # Section header
        hdr = QHBoxLayout()
        hdr.setContentsMargins(T.SPACING["lg"], T.SPACING["sm"], T.SPACING["sm"], T.SPACING["sm"])

        section_lbl = QLabel(SIDEBAR_RECENTS)
        section_lbl.setFont(QFont(T.FONT_FAMILY, T.FONT_SIZES["xs"]))
        section_lbl.setStyleSheet(
            f"color: {T.TEXT_TERTIARY}; letter-spacing: 0.08em; background: transparent;"
        )
        hdr.addWidget(section_lbl)
        hdr.addStretch()
        v.addLayout(hdr)

        # New chat button
        new_btn = QPushButton(SIDEBAR_NEW_CHAT)
        new_btn.setFixedHeight(36)
        new_btn.setFont(QFont(T.FONT_FAMILY, T.FONT_SIZES["base"]))
        new_btn.setStyleSheet(
            f"QPushButton {{ background: transparent; color: {T.TEXT_TERTIARY}; "
            f"  border: 1px dashed {T.BG_BORDER}; "
            f"  border-radius: {T.RADIUS['md']}px; margin: 0 {T.SPACING['sm']}px; }}"
            f"QPushButton:hover {{ border-style: solid; border-color: {T.BRAND_MUTED}; "
            f"  color: {T.TEXT_SECONDARY}; }}"
        )
        new_btn.setCursor(Qt.PointingHandCursor)
        new_btn.clicked.connect(self.new_chat_requested)
        v.addWidget(new_btn)
        v.addSpacing(T.SPACING["xs"])

        # Scroll area for conversations
        self._scroll = QScrollArea()
        self._scroll.setWidgetResizable(True)
        self._scroll.setHorizontalScrollBarPolicy(Qt.ScrollBarAlwaysOff)
        self._scroll.setVerticalScrollBarPolicy(Qt.ScrollBarAsNeeded)
        self._scroll.setStyleSheet(
            "QScrollArea { border: none; background: transparent; }"
        )

        self._list_widget = QWidget()
        self._list_widget.setStyleSheet("background: transparent;")
        self._list_v = QVBoxLayout(self._list_widget)
        self._list_v.setContentsMargins(0, 0, 0, 0)
        self._list_v.setSpacing(1)
        self._list_v.addStretch()

        self._scroll.setWidget(self._list_widget)
        v.addWidget(self._scroll, 1)

    # ── Public API ────────────────────────────────────────────────────────────

    def load_conversations(self, conversations: list) -> None:
        """Replace all items with the given list (most recent first)."""
        # Clear existing
        for item in self._items.values():
            item.deleteLater()
        self._items.clear()

        # Remove all but the stretch
        while self._list_v.count() > 1:
            item = self._list_v.takeAt(0)
            if item.widget():
                item.widget().deleteLater()

        for conv in conversations:
            self._add_item(conv)

    def add_or_update(self, conv: dict) -> None:
        cid = conv["id"]
        if cid in self._items:
            self._items[cid].update_title(conv["title"])
        else:
            self._add_item(conv)

    def set_active(self, cid: str) -> None:
        if self._active_id and self._active_id in self._items:
            self._items[self._active_id].set_active(False)
        self._active_id = cid
        if cid in self._items:
            self._items[cid].set_active(True)

    def reset(self):
        self.load_conversations([])

    # ── Internal ──────────────────────────────────────────────────────────────

    def _add_item(self, conv: dict) -> None:
        item = _ConvItem(conv)
        item.clicked.connect(self._on_item_clicked)
        item.rename_requested.connect(self._on_rename)
        item.delete_requested.connect(self._on_delete)
        self._items[conv["id"]] = item
        # Insert before the stretch
        self._list_v.insertWidget(self._list_v.count() - 1, item)

    def _on_item_clicked(self, cid: str) -> None:
        self.set_active(cid)
        self.conversation_selected.emit(cid)

    def _on_rename(self, cid: str) -> None:
        conv_item = self._items.get(cid)
        if not conv_item:
            return
        text, ok = QInputDialog.getText(
            self, CONV_RENAME, "New title:", text=conv_item.title
        )
        if ok and text.strip():
            conv_item.update_title(text.strip())
            self.conversation_renamed.emit(cid, text.strip())

    def _on_delete(self, cid: str) -> None:
        reply = QMessageBox.question(
            self, CONV_DELETE, CONV_DELETE_MSG,
            QMessageBox.Yes | QMessageBox.No,
        )
        if reply == QMessageBox.Yes:
            item = self._items.pop(cid, None)
            if item:
                item.deleteLater()
            self.conversation_deleted.emit(cid)


class _ConvItem(QWidget):
    clicked         = pyqtSignal(str)
    rename_requested = pyqtSignal(str)
    delete_requested = pyqtSignal(str)

    def __init__(self, conv: dict, parent=None):
        super().__init__(parent)
        self._id     = conv["id"]
        self.title   = conv.get("title", "Untitled")
        self._active = False
        self.setFixedHeight(36)
        self.setCursor(Qt.PointingHandCursor)
        self.setAttribute(Qt.WA_StyledBackground, True)

        row = QHBoxLayout(self)
        row.setContentsMargins(T.SPACING["lg"], 0, T.SPACING["sm"], 0)
        row.setSpacing(T.SPACING["sm"])

        icon = QLabel("💬")
        icon.setFixedWidth(16)
        icon.setStyleSheet("background: transparent; font-size: 11px;")
        row.addWidget(icon)

        self._title_lbl = QLabel(self.title)
        self._title_lbl.setFont(QFont(T.FONT_FAMILY, T.FONT_SIZES["base"]))
        self._title_lbl.setStyleSheet(f"color: {T.TEXT_SECONDARY}; background: transparent;")
        self._title_lbl.setMinimumWidth(0)
        row.addWidget(self._title_lbl, 1)

        self._menu_btn = QPushButton("…")
        self._menu_btn.setFixedSize(20, 20)
        self._menu_btn.setCursor(Qt.PointingHandCursor)
        self._menu_btn.setStyleSheet(
            f"QPushButton {{ background: transparent; color: {T.TEXT_TERTIARY}; "
            f"  border: none; font-size: 14px; }}"
            f"QPushButton:hover {{ color: {T.TEXT_PRIMARY}; }}"
        )
        self._menu_btn.hide()
        self._menu_btn.clicked.connect(self._show_menu)
        row.addWidget(self._menu_btn)

        self._refresh()

    def update_title(self, title: str) -> None:
        self.title = title
        self._title_lbl.setText(title)

    def set_active(self, active: bool) -> None:
        self._active = active
        self._refresh()

    def _refresh(self) -> None:
        if self._active:
            self.setStyleSheet(
                f"background: {T.BG_ELEVATED}; border-left: 2px solid {T.BRAND_PRIMARY}; "
                f"border-radius: {T.RADIUS['sm']}px;"
            )
            self._title_lbl.setStyleSheet(f"color: {T.TEXT_PRIMARY}; background: transparent;")
        else:
            self.setStyleSheet(
                "background: transparent; border-left: 2px solid transparent; "
                f"border-radius: {T.RADIUS['sm']}px;"
            )
            self._title_lbl.setStyleSheet(f"color: {T.TEXT_SECONDARY}; background: transparent;")

    def enterEvent(self, _e):
        self._menu_btn.show()
        if not self._active:
            self.setStyleSheet(
                f"background: {T.BG_OVERLAY}; border-left: 2px solid transparent; "
                f"border-radius: {T.RADIUS['sm']}px;"
            )
            self._title_lbl.setStyleSheet(f"color: {T.TEXT_PRIMARY}; background: transparent;")

    def leaveEvent(self, _e):
        self._menu_btn.hide()
        self._refresh()

    def mousePressEvent(self, event):
        if event.button() == Qt.LeftButton:
            self.clicked.emit(self._id)

    def _show_menu(self):
        menu = QMenu(self)
        menu.setStyleSheet(
            f"QMenu {{ background: {T.BG_ELEVATED}; border: 1px solid {T.BG_BORDER}; "
            f"  border-radius: {T.RADIUS['md']}px; color: {T.TEXT_PRIMARY}; padding: 4px; }}"
            f"QMenu::item {{ padding: 6px 16px; border-radius: {T.RADIUS['sm']}px; }}"
            f"QMenu::item:selected {{ background: {T.BG_OVERLAY}; }}"
        )
        menu.addAction(CONV_RENAME, lambda: self.rename_requested.emit(self._id))
        menu.addAction(CONV_DELETE, lambda: self.delete_requested.emit(self._id))
        menu.exec_(QCursor.pos())
