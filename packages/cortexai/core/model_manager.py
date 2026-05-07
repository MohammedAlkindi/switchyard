import logging
import threading
from dataclasses import dataclass
from datetime import datetime
from enum import Enum, auto
from typing import Any, Dict, List, Optional

log = logging.getLogger("CortexAI")

try:
    from transformers import pipeline
    HAS_TRANSFORMERS = True
except ImportError:
    HAS_TRANSFORMERS = False

try:
    import torch
    CUDA_AVAILABLE = torch.cuda.is_available()
except ImportError:
    CUDA_AVAILABLE = False


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
        if not HAS_TRANSFORMERS:
            log.warning("transformers not installed — cannot load model.")
            return
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
