from unittest.mock import MagicMock, patch
import importlib
import sys
import os

sys.path.insert(0, os.path.dirname(os.path.dirname(__file__)))


def _reload_client():
    if "clients.anthropic_client" in sys.modules:
        del sys.modules["clients.anthropic_client"]
    import clients.anthropic_client
    return clients.anthropic_client


@patch("clients.anthropic_client.HAS_ANTHROPIC", False)
def test_no_key_returns_message():
    mod = _reload_client()
    client = mod.AnthropicClient(api_key="")
    result = client.chat([{"role": "user", "content": "hi"}])
    assert "No API key" in result


def test_ready_false_without_key():
    mod = _reload_client()
    client = mod.AnthropicClient(api_key="")
    assert not client.ready


def test_set_api_key_marks_ready():
    mock_ant = MagicMock()
    mock_ant.Anthropic.return_value = MagicMock()
    with patch.dict("sys.modules", {"anthropic": mock_ant}):
        mod = _reload_client()
        mod.HAS_ANTHROPIC = True
        mod.anthropic = mock_ant
        client = mod.AnthropicClient()
        client.set_api_key("sk-ant-fake-key")
        assert client.ready
