import importlib.util
import logging
from pathlib import Path
from typing import Any, List

log = logging.getLogger("CortexAI")

_PLUGINS_DIR = Path(__file__).parent.parent / "plugins"


class PluginManager:
    def __init__(self):
        self._plugins: List[Any] = []

    def load_all(self, host: Any):
        if not _PLUGINS_DIR.exists():
            return
        for path in _PLUGINS_DIR.glob("*.py"):
            try:
                spec = importlib.util.spec_from_file_location(f"plugins.{path.stem}", path)
                module = importlib.util.module_from_spec(spec)
                spec.loader.exec_module(module)
                if hasattr(module, "initialize"):
                    plugin = module.initialize(host)
                    self._plugins.append(plugin)
                    log.info(f"Loaded plugin: {path.stem}")
            except Exception as e:
                log.warning(f"Failed to load plugin {path.stem}: {e}", exc_info=True)

    def get_all(self) -> List[Any]:
        return list(self._plugins)
