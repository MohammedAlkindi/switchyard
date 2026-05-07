import sys
import os
import types

sys.path.insert(0, os.path.dirname(os.path.dirname(__file__)))

# Stub PyQt5
for mod in ["PyQt5", "PyQt5.QtCore"]:
    if mod not in sys.modules:
        m = types.ModuleType(mod)
        sys.modules[mod] = m

qt_core = sys.modules["PyQt5.QtCore"]
qt_core.QThread = object
qt_core.pyqtSignal = lambda *a, **kw: None

from unittest.mock import MagicMock, patch


def test_no_key_returns_message():
    with patch.dict("sys.modules", {"anthropic": MagicMock(), "PyQt5": MagicMock(),
                                     "PyQt5.QtCore": MagicMock()}):
        from clients.anthropic_client import AnthropicClient
        client = AnthropicClient(api_key="")
        result = client.chat([{"role": "user", "content": "hi"}])
        assert "No API key" in result


def test_set_api_key_marks_ready():
    mock_ant = MagicMock()
    mock_ant.Anthropic.return_value = MagicMock()
    with patch.dict("sys.modules", {"anthropic": mock_ant, "PyQt5": MagicMock(),
                                     "PyQt5.QtCore": MagicMock()}):
        from clients import anthropic_client
        import importlib
        importlib.reload(anthropic_client)
        anthropic_client.HAS_ANTHROPIC = True
        anthropic_client.anthropic = mock_ant

        client = anthropic_client.AnthropicClient()
        client.set_api_key("sk-ant-fake-key")
        assert client.ready


def test_ready_false_without_key():
    with patch.dict("sys.modules", {"anthropic": MagicMock(), "PyQt5": MagicMock(),
                                     "PyQt5.QtCore": MagicMock()}):
        from clients.anthropic_client import AnthropicClient
        client = AnthropicClient(api_key="")
        assert not client.ready
