import os
import sys
from unittest.mock import MagicMock, patch

sys.path.insert(0, os.path.dirname(os.path.dirname(__file__)))

from PyQt5.QtWidgets import QApplication
_app = QApplication.instance() or QApplication([])


def _make_chat_tab():
    ai_core = MagicMock()
    ai_core.anthropic_client.ready = False
    ai_core.performance_metrics = MagicMock()
    ai_core.performance_metrics.connect = MagicMock()
    with patch("ui.tabs.chat_tab.ConversationStore") as mock_store:
        mock_store.return_value.list_recent.return_value = []
        from ui.tabs.chat_tab import ChatTab
        tab = ChatTab(ai_core)
    return tab


def test_search_finds_matching_messages():
    tab = _make_chat_tab()
    tab._messages = [
        {"role": "user",      "content": "Hello world"},
        {"role": "assistant", "content": "Hi there"},
        {"role": "user",      "content": "Hello again"},
    ]
    tab._on_search("hello")
    assert len(tab._search_results) == 2
    assert tab._search_cursor == 0


def test_search_next_advances_cursor():
    tab = _make_chat_tab()
    tab._messages = [
        {"role": "user", "content": "foo"},
        {"role": "user", "content": "foo bar"},
    ]
    tab._on_search("foo")
    assert tab._search_cursor == 0
    tab._on_search_next()
    assert tab._search_cursor == 1


def test_search_prev_wraps():
    tab = _make_chat_tab()
    tab._messages = [
        {"role": "user", "content": "foo"},
        {"role": "user", "content": "foo bar"},
    ]
    tab._on_search("foo")
    assert tab._search_cursor == 0
    tab._on_search_prev()
    assert tab._search_cursor == 1  # wraps to last


def test_search_empty_query_clears():
    tab = _make_chat_tab()
    tab._messages = [{"role": "user", "content": "hello"}]
    tab._on_search("hello")
    assert len(tab._search_results) == 1
    tab._on_search("")
    assert tab._search_results == []
    assert tab._search_cursor == -1
