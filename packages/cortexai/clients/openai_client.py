from __future__ import annotations

import logging
import os
from typing import Any, Callable, Dict, List, Optional

from PyQt5.QtCore import QThread, pyqtSignal

log = logging.getLogger("CortexAI")

try:
    import openai
    HAS_OPENAI = True
except ImportError:
    HAS_OPENAI = False


class OpenAIClient:
    DEFAULT_MODEL = "gpt-4o"
    MAX_HISTORY_TURNS = 20

    def __init__(self, api_key: str = ""):
        self._api_key = api_key or os.environ.get("OPENAI_API_KEY", "")
        self._client: Optional[Any] = None
        self._build_client()

    def _build_client(self):
        if not HAS_OPENAI or not self._api_key:
            self._client = None
            return
        self._client = openai.OpenAI(api_key=self._api_key)

    def set_api_key(self, key: str):
        self._api_key = key.strip()
        self._build_client()

    @property
    def ready(self) -> bool:
        return self._client is not None

    def chat(
        self,
        messages: List[Dict],
        system: str = "",
        model: str = DEFAULT_MODEL,
        max_tokens: int = 2048,
    ) -> str:
        if not self.ready:
            return "[CortexAI] No OpenAI API key set."
        trimmed = messages[-self.MAX_HISTORY_TURNS * 2:]
        all_msgs = ([{"role": "system", "content": system}] if system else []) + trimmed
        try:
            response = self._client.chat.completions.create(
                model=model, messages=all_msgs, max_tokens=max_tokens
            )
            return response.choices[0].message.content
        except openai.AuthenticationError:
            return "[CortexAI] Invalid OpenAI API key."
        except openai.RateLimitError:
            return "[CortexAI] OpenAI rate limit reached."
        except Exception as e:
            log.error(f"OpenAI error: {e}", exc_info=True)
            return f"[CortexAI] OpenAI error: {e}"

    def stream_chat(
        self,
        messages: List[Dict],
        system: str,
        model: str,
        max_tokens: int,
        on_token: Callable[[str], None],
        stop_check: Callable[[], bool] = lambda: False,
    ) -> None:
        if not self.ready:
            on_token("[CortexAI] No OpenAI API key set.")
            return
        trimmed = messages[-self.MAX_HISTORY_TURNS * 2:]
        all_msgs = ([{"role": "system", "content": system}] if system else []) + trimmed
        try:
            with self._client.chat.completions.stream(
                model=model, messages=all_msgs, max_tokens=max_tokens
            ) as stream:
                for text in stream.text_stream:
                    if stop_check():
                        break
                    on_token(text)
        except Exception as e:
            log.error(f"OpenAI streaming error: {e}", exc_info=True)
            raise


class OpenAIStreamingWorker(QThread):
    """QThread worker that streams OpenAI completions, matching AnthropicClient's signal interface."""

    token_ready    = pyqtSignal(str)
    finished_ok    = pyqtSignal()
    error_occurred = pyqtSignal(str)

    def __init__(
        self,
        client: OpenAIClient,
        messages: List[Dict],
        system_prompt: str,
        model: str,
        max_tokens: int = 2048,
        parent=None,
    ):
        super().__init__(parent)
        self._client = client
        self._messages = messages
        self._system_prompt = system_prompt
        self._model = model
        self._max_tokens = max_tokens
        self._cancelled = False

    def cancel(self):
        self._cancelled = True

    def run(self):
        try:
            self._client.stream_chat(
                messages=self._messages,
                system=self._system_prompt,
                model=self._model,
                max_tokens=self._max_tokens,
                on_token=self.token_ready.emit,
                stop_check=lambda: self._cancelled,
            )
            if not self._cancelled:
                self.finished_ok.emit()
        except Exception as e:
            self.error_occurred.emit(str(e))
