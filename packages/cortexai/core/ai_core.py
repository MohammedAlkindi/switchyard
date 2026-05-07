import hashlib
import logging
import threading
from datetime import datetime
from pathlib import Path
from typing import Dict, List, Optional

import psutil
import yaml
from PyQt5.QtCore import QObject, QTimer, pyqtSignal

from clients.anthropic_client import AnthropicClient
from core.conversation import ConversationEntry
from core.model_manager import HAS_TRANSFORMERS, ModelManager
from services.billing import BillingManager
from services.compliance import ComplianceManager
from services.plugin_manager import PluginManager
from services.rate_limiter import RateLimiter

log = logging.getLogger("CortexAI")

_CONFIGS_DIR = Path(__file__).parent.parent / "configs"

try:
    from langdetect import detect
except ImportError:
    def detect(text):
        return "unknown"

try:
    from cryptography.fernet import Fernet
    HAS_CRYPTO = True
except ImportError:
    HAS_CRYPTO = False

try:
    import pynvml
    HAS_NVML = True
except ImportError:
    HAS_NVML = False


class AICore(QObject):
    status_update = pyqtSignal(str, str)
    performance_metrics = pyqtSignal(dict)

    def __init__(self, parent=None):
        super().__init__(parent)
        self.model_manager = ModelManager()
        self.compliance = ComplianceManager()
        self.billing = BillingManager()
        self.rate_limiter = RateLimiter()
        self.plugin_manager = PluginManager()
        self.conversation_history: List[ConversationEntry] = []
        self.config = self._load_config()
        self._telemetry_start = datetime.now()
        self.anthropic_client = AnthropicClient()

        self._setup_telemetry_timer()
        self._setup_security()
        self.plugin_manager.load_all(self)
        log.info("AICore initialized.")

    def _load_config(self) -> Dict:
        config_path = _CONFIGS_DIR / "config.yaml"
        if config_path.exists():
            try:
                with open(config_path, encoding="utf-8") as f:
                    return yaml.safe_load(f) or {}
            except Exception as e:
                log.warning(f"Failed to load config: {e}")
        return self._default_config()

    def _default_config(self) -> Dict:
        return {
            "models": {
                "translation": "Helsinki-NLP/opus-mt-en-fr",
                "sentiment": "distilbert-base-uncased-finetuned-sst-2-english",
                "summarization": "facebook/bart-large-cnn",
                "embedding": "all-MiniLM-L6-v2",
            },
            "performance_mode": "BALANCED",
            "security": {"encryption_enabled": True, "audit_logging": True},
        }

    def _setup_security(self):
        if not HAS_CRYPTO:
            log.warning("cryptography not installed — encryption disabled.")
            self.encryption_key = None
            return
        key_path = _CONFIGS_DIR / "encryption.key"
        key_path.parent.mkdir(parents=True, exist_ok=True)
        if key_path.exists():
            self.encryption_key = key_path.read_bytes()
        else:
            self.encryption_key = Fernet.generate_key()
            key_path.write_bytes(self.encryption_key)
        log.info("Encryption key loaded.")

    def _setup_telemetry_timer(self):
        self._timer = QTimer(self)
        self._timer.timeout.connect(self._collect_metrics)
        self._timer.start(5000)

    def _collect_metrics(self):
        metrics = {
            "timestamp": datetime.now().isoformat(),
            "cpu": psutil.cpu_percent(),
            "memory": psutil.virtual_memory().percent,
            "disk": psutil.disk_usage("/").percent,
            "threads": threading.active_count(),
            "uptime_s": (datetime.now() - self._telemetry_start).total_seconds(),
        }
        try:
            net = psutil.net_io_counters()
            metrics["net_sent_mb"] = round(net.bytes_sent / 1e6, 2)
            metrics["net_recv_mb"] = round(net.bytes_recv / 1e6, 2)
        except Exception:
            pass
        if HAS_NVML:
            metrics["gpu"] = self._get_gpu_usage()
        self.performance_metrics.emit(metrics)

    def _get_gpu_usage(self) -> Optional[float]:
        try:
            pynvml.nvmlInit()
            handle = pynvml.nvmlDeviceGetHandleByIndex(0)
            info = pynvml.nvmlDeviceGetMemoryInfo(handle)
            pynvml.nvmlShutdown()
            return (info.used / info.total) * 100
        except Exception:
            return None

    def translate(self, text: str, target_lang: str = "fr") -> str:
        cache_key = hashlib.md5(f"{text}{target_lang}".encode()).hexdigest()
        if not hasattr(self, "_translation_cache"):
            self._translation_cache = {}
        if cache_key in self._translation_cache:
            return self._translation_cache[cache_key]
        model_name = "translation"
        model = self.model_manager.get_model(model_name)
        if model is None and HAS_TRANSFORMERS:
            self.model_manager.load_model(
                model_name, "translation",
                self.config["models"].get("translation", "Helsinki-NLP/opus-mt-en-fr"),
            )
            model = self.model_manager.get_model(model_name)
        if model is None:
            return f"[Translation unavailable: '{text}']"
        try:
            result = model(text)[0]["translation_text"]
            self._translation_cache[cache_key] = result
            return result
        except Exception as e:
            log.error(f"Translation failed: {e}")
            return f"[Translation error: {e}]"

    def analyze_sentiment(self, text: str) -> Dict:
        if not hasattr(self, "_sentiment_cache"):
            self._sentiment_cache = {}
        key = hashlib.md5(text.encode()).hexdigest()
        if key in self._sentiment_cache:
            return self._sentiment_cache[key]
        model = self.model_manager.get_model("sentiment")
        if model is None and HAS_TRANSFORMERS:
            self.model_manager.load_model(
                "sentiment", "sentiment-analysis",
                self.config["models"].get("sentiment", "distilbert-base-uncased-finetuned-sst-2-english"),
            )
            model = self.model_manager.get_model("sentiment")
        if model is None:
            return {"label": "NEUTRAL", "score": 0.5}
        try:
            result = model(text)[0]
            self._sentiment_cache[key] = result
            return result
        except Exception as e:
            log.error(f"Sentiment analysis failed: {e}")
            return {"label": "ERROR", "score": 0.0}

    def summarize(self, text: str, max_length: int = 100) -> str:
        model = self.model_manager.get_model("summarization")
        if model is None and HAS_TRANSFORMERS:
            self.model_manager.load_model(
                "summarization", "summarization",
                self.config["models"].get("summarization", "facebook/bart-large-cnn"),
            )
            model = self.model_manager.get_model("summarization")
        if model is None:
            return "[Summarization unavailable]"
        try:
            result = model(text, max_length=max_length, min_length=10, do_sample=False)
            return result[0]["summary_text"]
        except Exception as e:
            log.error(f"Summarization failed: {e}")
            return "[Summarization error]"

    def detect_language(self, text: str) -> str:
        try:
            return detect(text)
        except Exception:
            return "unknown"

    def add_to_history(self, entry: ConversationEntry):
        self.conversation_history.append(entry)

    def clear_history(self):
        self.conversation_history.clear()
