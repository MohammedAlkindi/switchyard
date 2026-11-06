import json
import tempfile
import importlib
import sys
import os
from pathlib import Path

sys.path.insert(0, os.path.dirname(os.path.dirname(__file__)))


def _make_settings_module(tmp):
    import core.user_settings as mod
    importlib.reload(mod)
    mod._SETTINGS_PATH = Path(tmp) / "user_settings.json"
    return mod


def test_defaults_when_no_file():
    with tempfile.TemporaryDirectory() as tmp:
        mod = _make_settings_module(tmp)
        settings = mod.load_user_settings()
        assert settings["max_tokens"] == 2048
        assert settings["temperature"] == 0.7
        assert settings["system_prompt"] == ""


def test_save_and_reload():
    with tempfile.TemporaryDirectory() as tmp:
        mod = _make_settings_module(tmp)
        mod.save_user_settings({"max_tokens": 4096, "display_name": "Alice"})
        loaded = mod.load_user_settings()
        assert loaded["max_tokens"] == 4096
        assert loaded["display_name"] == "Alice"


def test_corrupt_file_returns_defaults():
    with tempfile.TemporaryDirectory() as tmp:
        mod = _make_settings_module(tmp)
        mod._SETTINGS_PATH.write_text("{invalid json", encoding="utf-8")
        settings = mod.load_user_settings()
        assert "max_tokens" in settings  # returns defaults, not crash
