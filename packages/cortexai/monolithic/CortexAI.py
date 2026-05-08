# ╔══════════════════════════════════════════════════════════════╗
# ║  LEGACY REFERENCE FILE — NOT USED AT RUNTIME                ║
# ║  Active code lives in core/, clients/, services/, ui/        ║
# ║  Do NOT import from this file or modify it.                  ║
# ╚══════════════════════════════════════════════════════════════╝

"""
CortexAI - AI Chat Desktop Application
A PyQt5-based chat UI with multi-model support, analytics, and plugin system.

Requirements:
    pip install PyQt5 PyQtChart psutil anthropic
    pip install transformers sentence-transformers torch  # optional, for local ML features
    pip install fastapi uvicorn pyyaml langdetect cryptography pynvml  # optional extras

Usage:
    Set ANTHROPIC_API_KEY env var, or enter your key in the sidebar after launch.
    python CortexAI.py
"""

# ======================
# IMPORTS
# ======================

import os
import re
import sys
import csv
import copy
import json
import time
import hmac
import yaml
import hashlib
import logging
import platform
import threading
import importlib.util
import traceback
from pathlib import Path
from datetime import datetime, timedelta
from typing import Any, Dict, List, Optional, Tuple, Union
from dataclasses import dataclass, field
from enum import Enum, auto
from concurrent.futures import ThreadPoolExecutor, as_completed

import psutil

# PyQt5
from PyQt5.QtWidgets import (
    QApplication, QMainWindow, QWidget, QVBoxLayout, QHBoxLayout,
    QPushButton, QLabel, QLineEdit, QCheckBox, QComboBox, QTextEdit,
    QTabWidget, QSplashScreen, QShortcut, QAction, QToolTip, QMenu,
    QFileDialog, QMessageBox, QProgressBar, QSystemTrayIcon,
    QPlainTextEdit, QStatusBar, QSplitter, QFormLayout
)
from PyQt5.QtGui import (
    QIcon, QFont, QColor, QPalette, QPixmap,
    QSyntaxHighlighter, QTextCharFormat, QKeySequence,
    QPainter, QTextCursor, QCursor
)
from PyQt5.QtCore import Qt, QTimer, QThread, pyqtSignal, QRegularExpression, QObject

try:
    from PyQt5.QtChart import QChart, QChartView, QLineSeries, QValueAxis
    HAS_CHART = True
except ImportError:
    HAS_CHART = False

# Optional AI/ML imports
try:
    from transformers import pipeline, AutoTokenizer, AutoModelForSeq2SeqLM
    from sentence_transformers import SentenceTransformer
    HAS_TRANSFORMERS = True
except ImportError:
    HAS_TRANSFORMERS = False

try:
    import torch
    CUDA_AVAILABLE = torch.cuda.is_available()
except ImportError:
    CUDA_AVAILABLE = False

try:
    from langdetect import detect
except ImportError:
    def detect(text):
        return "unknown"

try:
    import markdown
    HAS_MARKDOWN = True
except ImportError:
    HAS_MARKDOWN = False

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

try:
    from fastapi import FastAPI, Request
    from fastapi.responses import JSONResponse
    from fastapi.middleware.cors import CORSMiddleware
    HAS_FASTAPI = True
except ImportError:
    HAS_FASTAPI = False

try:
    from jsonschema import validate, ValidationError
    HAS_JSONSCHEMA = True
except ImportError:
    HAS_JSONSCHEMA = False

try:
    import anthropic
    HAS_ANTHROPIC = True
except ImportError:
    HAS_ANTHROPIC = False

# ======================
# LOGGING SETUP
# ======================

def setup_logging() -> logging.Logger:
    logger = logging.getLogger("CortexAI")
    if logger.handlers:
        return logger
    logger.setLevel(logging.DEBUG)
    fmt = logging.Formatter("%(asctime)s [%(levelname)s] %(name)s: %(message)s")
    ch = logging.StreamHandler()
    ch.setLevel(logging.INFO)
    ch.setFormatter(fmt)
    fh = logging.FileHandler("cortexai.log", encoding="utf-8")
    fh.setLevel(logging.DEBUG)
    fh.setFormatter(fmt)
    logger.addHandler(ch)
    logger.addHandler(fh)
    return logger

log = logging.getLogger("CortexAI")

# ======================
# ENUMS & DATACLASSES
# ======================

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
class ConversationEntry:
    timestamp: datetime
    prompt: str
    response: str
    model_used: str
    metadata: Dict[str, Any] = field(default_factory=dict)
    summary: Optional[str] = None

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

# ======================
# CORE SERVICES
# ======================

class ModelManager:
    """Manages loading, caching, and metrics for AI models."""

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


class ComplianceManager:
    """Audit logging for compliance (GDPR, HIPAA, SOC2)."""

    def __init__(self):
        self._log: List[Dict] = []

    def record(self, user: str, action: str, resource: str, region: Optional[str] = None):
        entry = {
            "timestamp": datetime.now().isoformat(),
            "user": user,
            "action": action,
            "resource": resource,
            "region": region,
        }
        self._log.append(entry)
        log.debug(f"Audit: {entry}")

    def export(self, path: str):
        with open(path, "w", encoding="utf-8") as f:
            json.dump(self._log, f, indent=2)
        log.info(f"Audit log exported to {path}")

    def get_log(self) -> List[Dict]:
        return list(self._log)


class PluginManager:
    """Discovers and loads plugins from the plugins/ directory."""

    def __init__(self):
        self._plugins: List[Any] = []

    def load_all(self, host: Any):
        plugin_dir = Path("plugins")
        if not plugin_dir.exists():
            return
        for path in plugin_dir.glob("*.py"):
            try:
                spec = importlib.util.spec_from_file_location(f"plugins.{path.stem}", path)
                module = importlib.util.module_from_spec(spec)
                spec.loader.exec_module(module)
                if hasattr(module, "initialize"):
                    plugin = module.initialize(host)
                    self._plugins.append(plugin)
                    log.info(f"Loaded plugin: {path.stem}")
            except Exception as e:
                log.warning(f"Failed to load plugin {path.stem}: {e}")

    def get_all(self) -> List[Any]:
        return list(self._plugins)


class BillingManager:
    """Usage-based billing and cost tracking."""

    def __init__(self):
        self._records: List[Dict] = []

    def log_usage(self, user: str, model: str, tokens: int, cost: float):
        record = {
            "timestamp": datetime.now().isoformat(),
            "user": user,
            "model": model,
            "tokens": tokens,
            "cost": cost,
        }
        self._records.append(record)

    def get_report(self, user: Optional[str] = None) -> List[Dict]:
        if user:
            return [r for r in self._records if r["user"] == user]
        return list(self._records)

    def export(self, path: str):
        with open(path, "w", encoding="utf-8") as f:
            json.dump(self._records, f, indent=2)


class RateLimiter:
    """Per-user rate limiting."""

    def __init__(self, max_per_minute: int = 60):
        self._max = max_per_minute
        self._counts: Dict[str, Dict] = {}

    def allow(self, user: str) -> bool:
        now = datetime.now().replace(second=0, microsecond=0)
        user_data = self._counts.setdefault(user, {})
        user_data[now] = user_data.get(now, 0) + 1
        # Clean old windows
        for key in list(user_data):
            if key != now:
                del user_data[key]
        if user_data[now] > self._max:
            log.warning(f"Rate limit exceeded for user: {user}")
            return False
        return True


# ======================
# ANTHROPIC CLIENT
# ======================

class AnthropicClient:
    """Thin wrapper around the Anthropic Messages API with conversation history."""

    DEFAULT_MODEL = "claude-sonnet-4-20250514"
    MAX_HISTORY_TURNS = 20  # keep last N user/assistant pairs to avoid token bloat

    def __init__(self, api_key: str = ""):
        self._api_key = api_key
        self._client: Optional[Any] = None
        self._build_client()

    def _build_client(self):
        if not HAS_ANTHROPIC:
            log.warning("anthropic SDK not installed. Run: pip install anthropic")
            self._client = None
            return
        key = self._api_key or os.environ.get("ANTHROPIC_API_KEY", "")
        if key:
            self._client = anthropic.Anthropic(api_key=key)
        else:
            self._client = None

    def set_api_key(self, key: str):
        self._api_key = key.strip()
        self._build_client()

    @property
    def ready(self) -> bool:
        return self._client is not None

    def chat(
        self,
        messages: List[Dict[str, str]],
        system: str = "You are CortexAI, a helpful and concise AI assistant.",
        model: str = DEFAULT_MODEL,
        max_tokens: int = 2048,
    ) -> str:
        """Send a conversation and return the assistant reply text."""
        if not self.ready:
            return (
                "[CortexAI] No API key set. Enter your Anthropic API key in the sidebar "
                "or set the ANTHROPIC_API_KEY environment variable."
            )
        # Trim history to avoid context overflow
        trimmed = messages[-self.MAX_HISTORY_TURNS * 2:]
        try:
            response = self._client.messages.create(
                model=model,
                max_tokens=max_tokens,
                system=system,
                messages=trimmed,
            )
            return response.content[0].text
        except anthropic.AuthenticationError:
            return "[CortexAI] Invalid API key — please check the key in the sidebar."
        except anthropic.RateLimitError:
            return "[CortexAI] Rate limit reached. Please wait a moment and try again."
        except anthropic.APIConnectionError as e:
            return f"[CortexAI] Connection error: {e}"
        except Exception as e:
            log.error(f"Anthropic API error: {e}", exc_info=True)
            return f"[CortexAI] Unexpected error: {e}"


class ChatWorker(QThread):
    """Runs the Anthropic API call off the main thread to keep the UI responsive."""

    response_ready = pyqtSignal(str)
    error_occurred = pyqtSignal(str)

    def __init__(self, client: AnthropicClient, messages: List[Dict], system: str, parent=None):
        super().__init__(parent)
        self._client = client
        self._messages = messages
        self._system = system

    def run(self):
        try:
            reply = self._client.chat(self._messages, system=self._system)
            self.response_ready.emit(reply)
        except Exception as e:
            self.error_occurred.emit(str(e))


# ======================
# AI CORE (QObject for signals)
# ======================

class AICore(QObject):
    """Central AI orchestration with telemetry and plugin support."""

    status_update = pyqtSignal(str, str)        # message, level
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
        self.anthropic_client = AnthropicClient()  # picks up ANTHROPIC_API_KEY if set

        self._setup_telemetry_timer()
        self._setup_security()
        self.plugin_manager.load_all(self)
        log.info("AICore initialized.")

    # --- Config ---

    def _load_config(self) -> Dict:
        config_path = Path("configs/config.yaml")
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

    # --- Security ---

    def _setup_security(self):
        if not HAS_CRYPTO:
            log.warning("cryptography not installed — encryption disabled.")
            self.encryption_key = None
            return
        key_path = Path("configs/encryption.key")
        key_path.parent.mkdir(parents=True, exist_ok=True)
        if key_path.exists():
            self.encryption_key = key_path.read_bytes()
        else:
            self.encryption_key = Fernet.generate_key()
            key_path.write_bytes(self.encryption_key)
        log.info("Encryption key loaded.")

    # --- Telemetry ---

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

    # --- AI Methods ---

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
                self.config["models"].get("translation", "Helsinki-NLP/opus-mt-en-fr")
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
                self.config["models"].get("sentiment", "distilbert-base-uncased-finetuned-sst-2-english")
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
                self.config["models"].get("summarization", "facebook/bart-large-cnn")
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


# ======================
# FASTAPI SERVER (optional)
# ======================

def create_api_app(ai_core: AICore):
    if not HAS_FASTAPI:
        return None

    app = FastAPI(title="CortexAI API", version="1.0.0")
    app.add_middleware(
        CORSMiddleware,
        allow_origins=["*"],
        allow_methods=["*"],
        allow_headers=["*"],
    )

    @app.get("/health")
    def health():
        return {"status": "ok", "timestamp": datetime.now().isoformat()}

    @app.get("/v1/models")
    def list_models():
        return {"models": ai_core.model_manager.list_models()}

    @app.post("/v1/completions")
    async def completions(request: Request):
        body = await request.json()
        prompt = body.get("prompt", "")
        model = body.get("model", "default")
        return {
            "id": f"cmpl-{hashlib.md5(prompt.encode()).hexdigest()[:8]}",
            "object": "text_completion",
            "created": int(time.time()),
            "model": model,
            "choices": [{"text": f"[CortexAI] {prompt[:100]}...", "index": 0, "finish_reason": "stop"}],
        }

    @app.exception_handler(Exception)
    async def error_handler(request: Request, exc: Exception):
        log.error(f"API error: {exc}", exc_info=True)
        return JSONResponse(status_code=500, content={"error": str(exc)})

    return app


# ======================
# UI: SYNTAX HIGHLIGHTER
# ======================

class CodeHighlighter(QSyntaxHighlighter):
    """Simple Python syntax highlighter."""

    def __init__(self, parent=None):
        super().__init__(parent)
        self._rules = []

        keyword_fmt = QTextCharFormat()
        keyword_fmt.setForeground(QColor("#569CD6"))
        keyword_fmt.setFontWeight(QFont.Bold)
        keywords = [
            "def", "class", "import", "from", "return", "if", "else", "elif",
            "for", "while", "try", "except", "with", "as", "pass", "break",
            "continue", "True", "False", "None", "and", "or", "not", "in",
            "is", "lambda", "yield", "async", "await",
        ]
        for kw in keywords:
            pattern = QRegularExpression(rf"\b{kw}\b")
            self._rules.append((pattern, keyword_fmt))

        string_fmt = QTextCharFormat()
        string_fmt.setForeground(QColor("#CE9178"))
        self._rules.append((QRegularExpression(r'"[^"\\]*(\\.[^"\\]*)*"'), string_fmt))
        self._rules.append((QRegularExpression(r"'[^'\\]*(\\.[^'\\]*)*'"), string_fmt))

        comment_fmt = QTextCharFormat()
        comment_fmt.setForeground(QColor("#6A9955"))
        self._rules.append((QRegularExpression(r"#[^\n]*"), comment_fmt))

        number_fmt = QTextCharFormat()
        number_fmt.setForeground(QColor("#B5CEA8"))
        self._rules.append((QRegularExpression(r"\b\d+(\.\d+)?\b"), number_fmt))

    def highlightBlock(self, text: str):
        for pattern, fmt in self._rules:
            match_iter = pattern.globalMatch(text)
            while match_iter.hasNext():
                match = match_iter.next()
                self.setFormat(match.capturedStart(), match.capturedLength(), fmt)


# ======================
# UI: ANALYTICS TAB
# ======================

class AnalyticsTab(QWidget):
    """Real-time system metrics display."""

    def __init__(self, ai_core: AICore, parent=None):
        super().__init__(parent)
        self._ai_core = ai_core
        self._chart_data = {"cpu": [], "memory": [], "timestamps": []}
        self._max_points = 60
        self._setup_ui()
        ai_core.performance_metrics.connect(self._on_metrics)

    def _setup_ui(self):
        layout = QVBoxLayout(self)

        self._metrics_display = QTextEdit()
        self._metrics_display.setReadOnly(True)
        self._metrics_display.setFont(QFont("Consolas", 11))
        self._metrics_display.setStyleSheet(
            "background:#1e1e1e; color:#d4d4d4; border:1px solid #444; border-radius:4px;"
        )
        layout.addWidget(QLabel("System Metrics"))
        layout.addWidget(self._metrics_display)

        if HAS_CHART:
            self._setup_chart(layout)

        btn_row = QHBoxLayout()
        refresh_btn = QPushButton("Refresh")
        refresh_btn.clicked.connect(self._manual_refresh)
        export_btn = QPushButton("Export CSV")
        export_btn.clicked.connect(self._export_csv)
        btn_row.addWidget(refresh_btn)
        btn_row.addWidget(export_btn)
        btn_row.addStretch()
        layout.addLayout(btn_row)

    def _setup_chart(self, layout):
        self._cpu_series = QLineSeries()
        self._cpu_series.setName("CPU %")
        self._mem_series = QLineSeries()
        self._mem_series.setName("Memory %")

        chart = QChart()
        chart.setTitle("Real-Time System Performance")
        chart.setTheme(QChart.ChartThemeDark)
        chart.addSeries(self._cpu_series)
        chart.addSeries(self._mem_series)

        self._axis_x = QValueAxis()
        self._axis_x.setRange(0, self._max_points)
        self._axis_x.setLabelFormat("%d")
        self._axis_x.setTitleText("Seconds")

        self._axis_y = QValueAxis()
        self._axis_y.setRange(0, 100)
        self._axis_y.setTitleText("Usage (%)")

        chart.addAxis(self._axis_x, Qt.AlignBottom)
        chart.addAxis(self._axis_y, Qt.AlignLeft)
        self._cpu_series.attachAxis(self._axis_x)
        self._cpu_series.attachAxis(self._axis_y)
        self._mem_series.attachAxis(self._axis_x)
        self._mem_series.attachAxis(self._axis_y)

        chart_view = QChartView(chart)
        chart_view.setRenderHint(QPainter.Antialiasing)
        chart_view.setMinimumHeight(200)
        layout.addWidget(chart_view)

    def _on_metrics(self, metrics: Dict):
        lines = [
            f"CPU:        {metrics.get('cpu', 'N/A')}%",
            f"Memory:     {metrics.get('memory', 'N/A')}%",
            f"Disk:       {metrics.get('disk', 'N/A')}%",
            f"Threads:    {metrics.get('threads', 'N/A')}",
            f"Uptime:     {int(metrics.get('uptime_s', 0))}s",
            f"Net Sent:   {metrics.get('net_sent_mb', 'N/A')} MB",
            f"Net Recv:   {metrics.get('net_recv_mb', 'N/A')} MB",
        ]
        if "gpu" in metrics and metrics["gpu"] is not None:
            lines.append(f"GPU Mem:    {metrics['gpu']:.1f}%")
        self._metrics_display.setText("\n".join(lines))

        if HAS_CHART:
            self._chart_data["cpu"].append(metrics.get("cpu", 0))
            self._chart_data["memory"].append(metrics.get("memory", 0))
            if len(self._chart_data["cpu"]) > self._max_points:
                self._chart_data["cpu"].pop(0)
                self._chart_data["memory"].pop(0)
            self._cpu_series.clear()
            self._mem_series.clear()
            for i, (c, m) in enumerate(zip(self._chart_data["cpu"], self._chart_data["memory"])):
                self._cpu_series.append(i, c)
                self._mem_series.append(i, m)

    def _manual_refresh(self):
        self._ai_core._collect_metrics()

    def _export_csv(self):
        path, _ = QFileDialog.getSaveFileName(self, "Export Metrics", "", "CSV Files (*.csv)")
        if not path:
            return
        try:
            with open(path, "w", newline="", encoding="utf-8") as f:
                writer = csv.writer(f)
                writer.writerow(["Index", "CPU (%)", "Memory (%)"])
                for i, (c, m) in enumerate(zip(self._chart_data["cpu"], self._chart_data["memory"])):
                    writer.writerow([i, c, m])
            QMessageBox.information(self, "Exported", f"Metrics saved to {path}")
        except Exception as e:
            QMessageBox.critical(self, "Export Failed", str(e))


# ======================
# UI: CHAT TAB
# ======================

class ChatTab(QWidget):
    """Main chat interface — wired to Anthropic Claude API."""

    SYSTEM_PROMPT = (
        "You are CortexAI, a helpful, accurate, and concise AI assistant built into a "
        "desktop application. Respond clearly and use markdown formatting where appropriate."
    )

    def __init__(self, ai_core: AICore, parent=None):
        super().__init__(parent)
        self._ai_core = ai_core
        self._messages: List[Dict[str, str]] = []  # full conversation history for the API
        self._worker: Optional[ChatWorker] = None
        self._setup_ui()

    def _setup_ui(self):
        layout = QVBoxLayout(self)

        # Chat history display
        self._chat_display = QTextEdit()
        self._chat_display.setReadOnly(True)
        self._chat_display.setFont(QFont("Segoe UI", 12))
        self._chat_display.setStyleSheet(
            "background:#1e1e1e; color:#d4d4d4; border:1px solid #444; border-radius:4px; padding:8px;"
        )
        layout.addWidget(self._chat_display)

        # Typing indicator
        self._typing_label = QLabel("")
        self._typing_label.setStyleSheet("color:#888; font-size:10px; padding:2px 4px;")
        layout.addWidget(self._typing_label)

        # Input row
        input_row = QHBoxLayout()
        self._input_box = QPlainTextEdit()
        self._input_box.setPlaceholderText("Type your message… (Ctrl+Enter to send)")
        self._input_box.setMaximumHeight(80)
        self._input_box.setStyleSheet(
            "background:#252526; color:#d4d4d4; border:1px solid #444; border-radius:4px; padding:6px;"
        )

        btn_col = QVBoxLayout()
        self._send_btn = QPushButton("Send")
        self._send_btn.setMinimumWidth(80)
        self._send_btn.setStyleSheet(
            "QPushButton { background:#0e639c; color:white; border-radius:4px; padding:6px 12px; }"
            "QPushButton:hover { background:#1177bb; }"
            "QPushButton:disabled { background:#444; color:#888; }"
        )
        self._send_btn.clicked.connect(self._send_message)

        clear_btn = QPushButton("Clear")
        clear_btn.setMinimumWidth(80)
        clear_btn.setStyleSheet(
            "QPushButton { background:#3a3a3a; color:#d4d4d4; border-radius:4px; padding:6px 12px; }"
            "QPushButton:hover { background:#505050; }"
        )
        clear_btn.clicked.connect(self.clear_chat)

        btn_col.addWidget(self._send_btn)
        btn_col.addWidget(clear_btn)

        input_row.addWidget(self._input_box)
        input_row.addLayout(btn_col)
        layout.addLayout(input_row)

        # Keyboard shortcut
        shortcut = QShortcut(QKeySequence("Ctrl+Return"), self)
        shortcut.activated.connect(self._send_message)

        # Welcome message
        self._append_system("CortexAI is ready. Type a message to start chatting.")
        if not self._ai_core.anthropic_client.ready:
            self._append_system(
                "⚠ No API key detected. Enter your Anthropic API key in the sidebar to enable chat."
            )

    def _send_message(self):
        text = self._input_box.toPlainText().strip()
        if not text or self._worker is not None:
            return
        self._input_box.clear()
        self._append_message("You", text, "#4CAF50")

        # Add to conversation history
        self._messages.append({"role": "user", "content": text})

        # Disable input while waiting
        self._set_input_enabled(False)
        self._typing_label.setText("CortexAI is thinking…")

        # Kick off background thread
        self._worker = ChatWorker(
            self._ai_core.anthropic_client,
            list(self._messages),
            self.SYSTEM_PROMPT,
            parent=self,
        )
        self._worker.response_ready.connect(self._on_response)
        self._worker.error_occurred.connect(self._on_error)
        self._worker.finished.connect(self._on_worker_done)
        self._worker.start()

    def _on_response(self, reply: str):
        self._messages.append({"role": "assistant", "content": reply})
        self._append_message("CortexAI", reply, "#569CD6")

        # Log to conversation history
        if self._messages and len(self._messages) >= 2:
            user_msg = self._messages[-2].get("content", "")
            entry = ConversationEntry(
                timestamp=datetime.now(),
                prompt=user_msg,
                response=reply,
                model_used=AnthropicClient.DEFAULT_MODEL,
            )
            self._ai_core.add_to_history(entry)
            self._ai_core.compliance.record("user", "chat", "anthropic_api")

    def _on_error(self, error: str):
        self._append_system(f"⚠ Error: {error}")

    def _on_worker_done(self):
        self._worker = None
        self._set_input_enabled(True)
        self._typing_label.setText("")

    def _set_input_enabled(self, enabled: bool):
        self._input_box.setEnabled(enabled)
        self._send_btn.setEnabled(enabled)

    def _append_message(self, sender: str, text: str, color: str):
        timestamp = datetime.now().strftime("%H:%M:%S")
        self._chat_display.append(
            f'<span style="color:{color}; font-weight:bold;">[{timestamp}] {sender}:</span>'
        )
        # Preserve newlines in the response
        escaped = text.replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;")
        escaped_html = escaped.replace("\n", "<br>")
        self._chat_display.append(f'<span style="color:#d4d4d4;">{escaped_html}</span><br>')
        self._chat_display.moveCursor(QTextCursor.End)

    def _append_system(self, text: str):
        self._chat_display.append(
            f'<span style="color:#888; font-style:italic;">{text}</span><br>'
        )
        self._chat_display.moveCursor(QTextCursor.End)

    def clear_chat(self):
        self._messages.clear()
        self._chat_display.clear()
        self._ai_core.clear_history()
        self._append_system("Chat cleared. Starting a new conversation.")


# ======================
# UI: DOCUMENTATION TAB
# ======================

class DocumentationTab(QWidget):
    def __init__(self, parent=None):
        super().__init__(parent)
        layout = QVBoxLayout(self)

        self._display = QTextEdit()
        self._display.setReadOnly(True)
        self._display.setFont(QFont("Segoe UI", 11))
        self._display.setStyleSheet(
            "background:#1e1e1e; color:#d4d4d4; border:1px solid #444; border-radius:4px; padding:8px;"
        )
        self._display.setText(self._load_docs())
        layout.addWidget(self._display)

    def _load_docs(self) -> str:
        doc_path = Path("docs/user_guide.txt")
        if doc_path.exists():
            try:
                return doc_path.read_text(encoding="utf-8")
            except Exception:
                pass
        return (
            "Welcome to CortexAI!\n\n"
            "Getting Started:\n"
            "  1. Type a message in the Chat tab and press Ctrl+Enter or click Send.\n"
            "  2. Check the Analytics tab for real-time system metrics.\n"
            "  3. Configure models in configs/config.yaml.\n"
            "  4. Add plugins to the plugins/ directory.\n\n"
            "Features:\n"
            "  - Sentiment analysis\n"
            "  - Text translation (en→fr by default)\n"
            "  - Text summarization\n"
            "  - Language detection\n"
            "  - Plugin system\n"
            "  - Audit/compliance logging\n"
            "  - Optional FastAPI REST server\n\n"
            "Place docs/user_guide.txt for custom documentation."
        )


# ======================
# UI: SIDEBAR
# ======================

class Sidebar(QWidget):
    model_changed = pyqtSignal(str)
    mode_changed = pyqtSignal(str)
    api_key_changed = pyqtSignal(str)

    def __init__(self, parent=None):
        super().__init__(parent)
        self.setFixedWidth(220)
        self.setStyleSheet("background:#252526; color:#d4d4d4;")
        layout = QVBoxLayout(self)
        layout.setContentsMargins(10, 10, 10, 10)
        layout.setSpacing(12)

        # --- API Key ---
        layout.addWidget(self._section_label("ANTHROPIC API KEY"))
        self._api_key_input = QLineEdit()
        self._api_key_input.setPlaceholderText("sk-ant-…")
        self._api_key_input.setEchoMode(QLineEdit.Password)
        self._api_key_input.setStyleSheet(
            "background:#1e1e1e; color:#d4d4d4; border:1px solid #444; "
            "border-radius:3px; padding:4px;"
        )
        # Pre-fill from environment if available
        env_key = os.environ.get("ANTHROPIC_API_KEY", "")
        if env_key:
            self._api_key_input.setText(env_key)
        self._api_key_input.editingFinished.connect(
            lambda: self.api_key_changed.emit(self._api_key_input.text().strip())
        )
        layout.addWidget(self._api_key_input)

        self._key_status = QLabel("⚪ No key set" if not env_key else "🟢 Key loaded from env")
        self._key_status.setStyleSheet("color:#888; font-size:10px;")
        self._key_status.setWordWrap(True)
        layout.addWidget(self._key_status)

        layout.addWidget(self._section_label("MODEL"))
        self._model_combo = QComboBox()
        self._model_combo.addItems([
            "Smart Routing (Auto)",
            "OpenAI GPT-4",
            "Anthropic Claude",
            "Self-Hosted Llama",
            "Hybrid Ensemble",
        ])
        self._model_combo.currentTextChanged.connect(self.model_changed)
        layout.addWidget(self._model_combo)

        layout.addWidget(self._section_label("PERFORMANCE"))
        self._mode_combo = QComboBox()
        self._mode_combo.addItems(["Balanced", "Speed", "Quality", "Extreme"])
        self._mode_combo.currentTextChanged.connect(self.mode_changed)
        layout.addWidget(self._mode_combo)

        layout.addWidget(self._section_label("FEATURES"))
        self._toggles = {
            "legal": QCheckBox("Legal Review"),
            "privacy": QCheckBox("Enterprise Privacy"),
            "memory": QCheckBox("Conversation Memory"),
            "analytics": QCheckBox("Analytics"),
        }
        for cb in self._toggles.values():
            layout.addWidget(cb)

        layout.addStretch()
        layout.addWidget(QLabel(f"v1.0 | Python {sys.version.split()[0]}"))

    def _section_label(self, text: str) -> QLabel:
        lbl = QLabel(text)
        lbl.setStyleSheet("color:#888; font-size:10px; font-weight:bold; margin-top:8px;")
        return lbl

    def set_key_status(self, ok: bool):
        if ok:
            self._key_status.setText("🟢 Connected")
            self._key_status.setStyleSheet("color:#4CAF50; font-size:10px;")
        else:
            self._key_status.setText("🔴 Invalid key")
            self._key_status.setStyleSheet("color:#f44336; font-size:10px;")


# ======================
# MAIN WINDOW
# ======================

class MainWindow(QMainWindow):
    def __init__(self):
        super().__init__()
        self.setWindowTitle("CortexAI")
        self.resize(1200, 800)
        self.setStyleSheet("background:#1e1e1e; color:#d4d4d4; font-family:'Segoe UI',Arial,sans-serif;")

        self._ai_core = AICore(parent=self)
        self._ai_core.status_update.connect(self._on_status_update)

        self._setup_ui()
        self._setup_status_bar()
        self._setup_tray()
        self._setup_menu()

        log.info("MainWindow ready.")

    def _setup_ui(self):
        central = QWidget()
        self.setCentralWidget(central)
        root = QHBoxLayout(central)
        root.setContentsMargins(0, 0, 0, 0)
        root.setSpacing(0)

        self._sidebar = Sidebar()
        self._sidebar.model_changed.connect(self._on_model_change)
        self._sidebar.api_key_changed.connect(self._on_api_key_change)

        self._tabs = QTabWidget()
        self._tabs.setStyleSheet(
            "QTabWidget::pane { border:1px solid #333; }"
            "QTabBar::tab { background:#252526; color:#888; padding:6px 14px; }"
            "QTabBar::tab:selected { color:#fff; border-bottom:2px solid #0e639c; }"
        )

        self._chat_tab = ChatTab(self._ai_core)
        self._analytics_tab = AnalyticsTab(self._ai_core)
        self._docs_tab = DocumentationTab()

        self._tabs.addTab(self._chat_tab, "Chat")
        self._tabs.addTab(self._analytics_tab, "Analytics")
        self._tabs.addTab(self._docs_tab, "Docs")

        splitter = QSplitter(Qt.Horizontal)
        splitter.addWidget(self._sidebar)
        splitter.addWidget(self._tabs)
        splitter.setSizes([220, 980])
        root.addWidget(splitter)

    def _setup_status_bar(self):
        bar = QStatusBar()
        self.setStatusBar(bar)
        self._status_label = QLabel("Ready")
        bar.addPermanentWidget(self._status_label)

    def _setup_tray(self):
        self._tray = QSystemTrayIcon(self)
        menu = QMenu()
        menu.addAction("Show", self.show)
        menu.addAction("Exit", QApplication.quit)
        self._tray.setContextMenu(menu)
        self._tray.show()

    def _setup_menu(self):
        menubar = self.menuBar()
        menubar.setStyleSheet("background:#2d2d2d; color:#d4d4d4;")

        file_menu = menubar.addMenu("File")
        file_menu.addAction("Clear Chat", self._chat_tab.clear_chat)
        file_menu.addAction("Export Audit Log", self._export_audit)
        file_menu.addSeparator()
        file_menu.addAction("Exit", QApplication.quit)

        help_menu = menubar.addMenu("Help")
        help_menu.addAction("About", self._show_about)

    def _on_status_update(self, message: str, level: str):
        self._status_label.setText(message)
        log.log(
            logging.INFO if level == "info" else
            logging.WARNING if level == "warning" else
            logging.ERROR,
            message
        )

    def _on_model_change(self, model_name: str):
        self._status_label.setText(f"Model: {model_name}")

    def _on_api_key_change(self, key: str):
        self._ai_core.anthropic_client.set_api_key(key)
        ok = self._ai_core.anthropic_client.ready
        self._sidebar.set_key_status(ok)
        self._status_label.setText("API key updated." if ok else "API key cleared.")

    def _export_audit(self):
        path, _ = QFileDialog.getSaveFileName(self, "Export Audit Log", "", "JSON Files (*.json)")
        if path:
            self._ai_core.compliance.export(path)
            QMessageBox.information(self, "Exported", f"Audit log saved to {path}")

    def _show_about(self):
        QMessageBox.about(
            self, "About CortexAI",
            "CortexAI v1.0\n\n"
            "A clean, modular AI chat platform.\n"
            f"Python {sys.version.split()[0]} | PyQt5\n"
            f"Platform: {platform.system()} {platform.release()}"
        )


# ======================
# SPLASH SCREEN
# ======================

class SplashScreen(QSplashScreen):
    def __init__(self):
        px = QPixmap(400, 250)
        px.fill(QColor("#1e1e1e"))
        super().__init__(px)
        self.setWindowFlag(Qt.FramelessWindowHint)

        self._progress = QProgressBar(self)
        self._progress.setGeometry(20, 210, 360, 20)
        self._progress.setStyleSheet(
            "QProgressBar { background:#333; border-radius:4px; }"
            "QProgressBar::chunk { background:#0e639c; border-radius:4px; }"
        )
        self._progress.setMaximum(100)
        self._progress.setValue(0)

        painter = QPainter(px)
        painter.setPen(QColor("#d4d4d4"))
        painter.setFont(QFont("Segoe UI", 20, QFont.Bold))
        painter.drawText(px.rect(), Qt.AlignCenter, "CortexAI")
        painter.end()
        self.setPixmap(px)

    def set_progress(self, value: int):
        self._progress.setValue(value)
        QApplication.processEvents()


# ======================
# ENTRY POINT
# ======================

def main():
    QApplication.setAttribute(Qt.AA_EnableHighDpiScaling)
    QApplication.setAttribute(Qt.AA_UseHighDpiPixmaps)

    app = QApplication(sys.argv)
    app.setApplicationName("CortexAI")
    app.setApplicationVersion("1.0")
    app.setStyle("Fusion")

    # Dark palette
    palette = QPalette()
    palette.setColor(QPalette.Window, QColor("#1e1e1e"))
    palette.setColor(QPalette.WindowText, QColor("#d4d4d4"))
    palette.setColor(QPalette.Base, QColor("#252526"))
    palette.setColor(QPalette.AlternateBase, QColor("#2d2d2d"))
    palette.setColor(QPalette.Text, QColor("#d4d4d4"))
    palette.setColor(QPalette.Button, QColor("#2d2d2d"))
    palette.setColor(QPalette.ButtonText, QColor("#d4d4d4"))
    palette.setColor(QPalette.Highlight, QColor("#0e639c"))
    palette.setColor(QPalette.HighlightedText, QColor("#ffffff"))
    app.setPalette(palette)

    splash = SplashScreen()
    splash.show()

    for i in range(0, 101, 20):
        splash.set_progress(i)
        time.sleep(0.05)

    try:
        window = MainWindow()
        splash.finish(window)
        window.show()
        sys.exit(app.exec_())
    except Exception as e:
        splash.close()
        log.critical(f"Fatal startup error: {e}", exc_info=True)
        QMessageBox.critical(None, "Fatal Error", f"Failed to start:\n{e}\n\nSee cortexai.log for details.")
        sys.exit(1)


if __name__ == "__main__":
    main()