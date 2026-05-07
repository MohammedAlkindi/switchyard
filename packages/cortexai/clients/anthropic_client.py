import logging
import os
from typing import Any, Dict, List, Optional

from PyQt5.QtCore import QThread, pyqtSignal

log = logging.getLogger("CortexAI")

try:
    import anthropic
    HAS_ANTHROPIC = True
except ImportError:
    HAS_ANTHROPIC = False


class AnthropicClient:
    DEFAULT_MODEL = "claude-sonnet-4-20250514"
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
        if not self.ready:
            return (
                "[CortexAI] No API key set. Enter your Anthropic API key in the sidebar "
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
            return "[CortexAI] Invalid API key — please check the key in the sidebar."
        except anthropic.RateLimitError:
            return "[CortexAI] Rate limit reached. Please wait a moment and try again."
        except anthropic.APIConnectionError as e:
            return f"[CortexAI] Connection error: {e}"
        except Exception as e:
            log.error(f"Anthropic API error: {e}", exc_info=True)
            return f"[CortexAI] Unexpected error: {e}"


class ChatWorker(QThread):
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
