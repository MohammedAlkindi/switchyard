from unittest.mock import MagicMock, patch
import importlib
import sys
import os

sys.path.insert(0, os.path.dirname(os.path.dirname(__file__)))


def _reload_client():
    if "clients.openai_client" in sys.modules:
        del sys.modules["clients.openai_client"]
    import clients.openai_client
    return clients.openai_client


def test_no_key_returns_message():
    mock_openai = MagicMock()
    with patch.dict("sys.modules", {"openai": mock_openai}):
        mod = _reload_client()
        mod.HAS_OPENAI = False
        client = mod.OpenAIClient(api_key="")
        result = client.chat([{"role": "user", "content": "hi"}])
        assert "No OpenAI API key" in result


def test_ready_false_without_key():
    mock_openai = MagicMock()
    with patch.dict("sys.modules", {"openai": mock_openai}):
        with patch("core.user_settings.load_user_settings", return_value={}):
            mod = _reload_client()
            client = mod.OpenAIClient(api_key="")
            assert not client.ready


def test_set_api_key_marks_ready():
    mock_openai = MagicMock()
    mock_openai.OpenAI.return_value = MagicMock()
    with patch.dict("sys.modules", {"openai": mock_openai}):
        mod = _reload_client()
        mod.HAS_OPENAI = True
        mod.openai = mock_openai
        client = mod.OpenAIClient()
        client.set_api_key("sk-fake-key")
        assert client.ready
