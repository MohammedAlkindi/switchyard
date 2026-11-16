import logging
import threading
from dataclasses import dataclass
from datetime import datetime
from enum import Enum, auto
from typing import Any, Dict, List, Optional

log = logging.getLogger("CortexAI")

# Lazy imports for optional ML dependencies to avoid Windows C++ DLL deadlocks during module collection
HAS_TRANSFORMERS = False
CUDA_AVAILABLE = False


def _init_local_ml():
    global HAS_TRANSFORMERS, CUDA_AVAILABLE
    if HAS_TRANSFORMERS or CUDA_AVAILABLE:
        return HAS_TRANSFORMERS
    try:
        import torch
        CUDA_AVAILABLE = bool(torch.cuda.is_available())
    except (ImportError, Exception):
        CUDA_AVAILABLE = False

    try:
        from transformers import pipeline  # noqa: F401
        HAS_TRANSFORMERS = True
    except (ImportError, Exception):
        HAS_TRANSFORMERS = False
    return HAS_TRANSFORMERS


def has_transformers() -> bool:
    """Probe for transformers on first call, so importing this module never loads torch."""
    return _init_local_ml()


class ModelType(Enum):
    AUTO = auto()
    OPENAI = auto()
    ANTHROPIC = auto()
    SELF_HOSTED = auto()
    HYBRID = auto()
    LOCAL = auto()
    CUSTOM = auto()


class PerformanceMode(Enum):
    BALANCED = auto()
    SPEED = auto()
    QUALITY = auto()
    EXTREME = auto()


@dataclass
class ModelMetrics:
    model_name: str
    total_requests: int = 0
    avg_response_time: float = 0.0
    error_count: int = 0
    last_used: Optional[datetime] = None

    def update(self, response_time: float, success: bool):
        self.total_requests += 1
        if success:
            n = self.total_requests
            self.avg_response_time = (self.avg_response_time * (n - 1) + response_time) / n
        else:
            self.error_count += 1
        self.last_used = datetime.now()


class ModelManager:
    def __init__(self):
        self._models: Dict[str, Any] = {}
        self._metrics: Dict[str, ModelMetrics] = {}
        self._lock = threading.Lock()

    def load_model(self, name: str, pipeline_type: str, model_path: str):
        if not HAS_TRANSFORMERS and not _init_local_ml():
            log.warning("transformers not installed — cannot load model.")
            return
        from transformers import pipeline
        with self._lock:
            if name not in self._models:
                log.info(f"Loading model: {name}")
                device = 0 if CUDA_AVAILABLE else -1
                self._models[name] = pipeline(pipeline_type, model=model_path, device=device)
                self._metrics[name] = ModelMetrics(model_name=name)

    def get_model(self, name: str) -> Optional[Any]:
        with self._lock:
            return self._models.get(name)

    def unload_model(self, name: str) -> bool:
        with self._lock:
            if name in self._models:
                del self._models[name]
                del self._metrics[name]
                log.info(f"Unloaded model: {name}")
                return True
            return False

    def update_metrics(self, name: str, response_time: float, success: bool):
        if name in self._metrics:
            self._metrics[name].update(response_time, success)

    def get_metrics(self, name: str) -> Optional[ModelMetrics]:
        return self._metrics.get(name)

    def list_models(self) -> List[str]:
        with self._lock:
            return list(self._models.keys())
