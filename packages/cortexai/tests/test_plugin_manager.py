import importlib
import os
import sys
import tempfile
from pathlib import Path

sys.path.insert(0, os.path.dirname(os.path.dirname(__file__)))


def _make_pm(tmp):
    import services.plugin_manager as mod
    importlib.reload(mod)
    mod._PLUGINS_DIR = Path(tmp)
    return mod.PluginManager()


def test_load_plugin_with_initialize():
    with tempfile.TemporaryDirectory() as tmp:
        (Path(tmp) / "my_plugin.py").write_text(
            "class MyPlugin:\n"
            "    name = 'MyPlugin'\n"
            "    version = '1.0.0'\n"
            "def initialize(host):\n"
            "    return MyPlugin()\n",
            encoding="utf-8",
        )
        pm = _make_pm(tmp)
        pm.load_all(host=None)
        plugins = pm.get_all()
        assert len(plugins) == 1
        assert plugins[0].name == "MyPlugin"


def test_load_plugin_without_initialize_is_skipped():
    with tempfile.TemporaryDirectory() as tmp:
        (Path(tmp) / "bad_plugin.py").write_text("x = 1\n", encoding="utf-8")
        pm = _make_pm(tmp)
        pm.load_all(host=None)
        assert pm.get_all() == []


def test_load_crashing_plugin_is_skipped():
    with tempfile.TemporaryDirectory() as tmp:
        (Path(tmp) / "crash_plugin.py").write_text(
            "def initialize(host):\n    raise RuntimeError('bang')\n",
            encoding="utf-8",
        )
        pm = _make_pm(tmp)
        pm.load_all(host=None)  # must not raise
        assert pm.get_all() == []
