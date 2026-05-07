import logging
import os
from typing import Any, Callable, Dict, List, Optional

from PyQt5.QtCore import QThread, pyqtSignal

log = logging.getLogger("CortexAI")

try:
    import anthropic
    HAS_ANTHROPIC = True
except ImportError:
    HAS_ANTHROPIC = False


class AnthropicClient:
    DEFAULT_MODEL    = "claude-sonnet-4-20250514"
    MAX_HISTORY_TURNS = 20

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
        self._client = anthropic.Anthropic(api_key=key) if key else None

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
        if not self.ready:
            return (
                "[CortexAI] No API key set. Enter your Anthropic API key in Settings "
                "or set the ANTHROPIC_API_KEY environment variable."
            )
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
            return "[CortexAI] Invalid API key — check Settings."
        except anthropic.RateLimitError:
            return "[CortexAI] Rate limit reached. Please wait a moment."
        except anthropic.APIConnectionError as e:
            return f"[CortexAI] Connection error: {e}"
        except Exception as e:
            log.error(f"Anthropic API error: {e}", exc_info=True)
            return f"[CortexAI] Unexpected error: {e}"

    def stream_chat(
        self,
        messages: List[Dict[str, str]],
        system: str,
        model: str,
        max_tokens: int,
        on_token: Callable[[str], None],
        stop_check: Callable[[], bool] = lambda: False,
    ) -> None:
        """Stream tokens, calling on_token(text) for each chunk."""
        if not self.ready:
            on_token("[CortexAI] No API key set. Add your key in Settings.")
            return
        trimmed = messages[-self.MAX_HISTORY_TURNS * 2:]
        try:
            with self._client.messages.stream(
                model=model,
                max_tokens=max_tokens,
                system=system,
                messages=trimmed,
            ) as stream:
                for text in stream.text_stream:
                    if stop_check():
                        break
                    on_token(text)
        except anthropic.AuthenticationError as e:
            raise RuntimeError("Invalid API key — check Settings.") from e
        except anthropic.RateLimitError as e:
            raise RuntimeError("Rate limit reached. Please wait.") from e
        except anthropic.APIConnectionError as e:
            raise RuntimeError(f"Connection error: {e}") from e
        except Exception as e:
            log.error(f"Anthropic streaming error: {e}", exc_info=True)
            raise


class ChatWorker(QThread):
    """Non-streaming chat worker (kept for backward compatibility)."""
    response_ready = pyqtSignal(str)
    error_occurred = pyqtSignal(str)

    def __init__(self, client: AnthropicClient, messages: List[Dict], system: str, parent=None):
        super().__init__(parent)
        self._client   = client
        self._messages = messages
        self._system   = system

    def run(self):
        try:
            reply = self._client.chat(self._messages, system=self._system)
            self.response_ready.emit(reply)
        except Exception as e:
            self.error_occurred.emit(str(e))


class StreamingChatWorker(QThread):
    """Streaming chat worker that emits token_ready for each chunk."""
    token_ready    = pyqtSignal(str)
    finished_ok    = pyqtSignal()
    error_occurred = pyqtSignal(str)

    def __init__(
        self,
        client: AnthropicClient,
        messages: List[Dict],
        system: str,
        model: str = AnthropicClient.DEFAULT_MODEL,
        max_tokens: int = 2048,
        parent=None,
    ):
        super().__init__(parent)
        self._client     = client
        self._messages   = messages
        self._system     = system
        self._model      = model
        self._max_tokens = max_tokens
        self._cancelled  = False

    def cancel(self):
        self._cancelled = True

    def run(self):
        try:
            self._client.stream_chat(
                self._messages,
                self._system,
                self._model,
                self._max_tokens,
                on_token=self._emit_token,
                stop_check=lambda: self._cancelled,
            )
            if not self._cancelled:
                self.finished_ok.emit()
        except Exception as e:
            if not self._cancelled:
                self.error_occurred.emit(str(e))

    def _emit_token(self, text: str):
        if not self._cancelled:
            self.token_ready.emit(text)
