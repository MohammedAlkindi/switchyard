from __future__ import annotations

import json
import logging
import uuid
from datetime import datetime
from pathlib import Path
from typing import Dict, List, Optional

log = logging.getLogger("CortexAI")

_CONV_DIR = Path(__file__).parent.parent / "configs" / "conversations"


def _now() -> str:
    return datetime.now().isoformat()


class ConversationStore:
    """Persistent JSON-backed conversation storage with lazy-init flush timer."""

    def __init__(self):
        _CONV_DIR.mkdir(parents=True, exist_ok=True)
        self._cache: Dict[str, dict] = {}
        self._dirty: set[str] = set()
        self._flush_timer = None  # lazy init — requires QApplication to exist
        self._load_all()

    # ── Public API ────────────────────────────────────────────────────────────

    def create(self, model: str = "claude-sonnet-4-20250514") -> dict:
        cid = str(uuid.uuid4())
        conv = {
            "id":         cid,
            "title":      "New conversation",
            "created_at": _now(),
            "updated_at": _now(),
            "model":      model,
            "messages":   [],
            "metadata": {
                "total_tokens":    0,
                "total_cost_usd":  0.0,
                "message_count":   0,
            },
        }
        self._cache[cid] = conv
        self._save(cid)
        log.debug(f"Created conversation {cid}")
        return conv

    def get(self, cid: str) -> Optional[dict]:
        return self._cache.get(cid)

    def list_recent(self, limit: int = 50) -> List[dict]:
        convs = list(self._cache.values())
        convs.sort(key=lambda c: c.get("updated_at", ""), reverse=True)
        return convs[:limit]

    def add_message(
        self,
        cid: str,
        role: str,
        content: str,
        tokens: int = 0,
        latency_ms: int = 0,
    ) -> None:
        conv = self._cache.get(cid)
        if not conv:
            return
        msg = {
            "role":       role,
            "content":    content,
            "timestamp":  _now(),
            "tokens":     tokens,
            "latency_ms": latency_ms,
        }
        conv["messages"].append(msg)
        conv["updated_at"] = _now()
        conv["metadata"]["message_count"] += 1
        conv["metadata"]["total_tokens"]  += tokens

        if role == "user" and conv["title"] == "New conversation":
            raw = content.strip().replace("\n", " ")
            conv["title"] = raw[:52] + ("…" if len(raw) > 52 else "")

        self._dirty.add(cid)
        self._ensure_timer()

    def rename(self, cid: str, title: str) -> None:
        conv = self._cache.get(cid)
        if not conv:
            return
        conv["title"] = title[:80]
        conv["updated_at"] = _now()
        self._dirty.add(cid)
        self._ensure_timer()

    def delete(self, cid: str) -> None:
        if cid not in self._cache:
            return
        del self._cache[cid]
        self._dirty.discard(cid)
        path = _CONV_DIR / f"{cid}.json"
        if path.exists():
            path.unlink()
        log.debug(f"Deleted conversation {cid}")

    def get_messages(self, cid: str) -> List[Dict]:
        conv = self._cache.get(cid)
        return conv["messages"] if conv else []

    # ── Internal ──────────────────────────────────────────────────────────────

    def _ensure_timer(self):
        if self._flush_timer is None:
            from PyQt5.QtCore import QTimer
            self._flush_timer = QTimer()
            self._flush_timer.setInterval(2000)
            self._flush_timer.timeout.connect(self._flush_dirty)
            self._flush_timer.start()

    def _flush_dirty(self):
        for cid in list(self._dirty):
            self._save(cid)
        self._dirty.clear()

    def _load_all(self):
        for path in _CONV_DIR.glob("*.json"):
            try:
                data = json.loads(path.read_text(encoding="utf-8"))
                if "id" not in data:
                    raise ValueError("Missing 'id' field")
                self._cache[data["id"]] = data
            except Exception as e:
                log.warning(f"Corrupt conversation file {path.name}: {e} — moving to .bak")
                try:
                    path.rename(path.with_suffix(".json.bak"))
                except Exception:
                    pass

    def _save(self, cid: str):
        conv = self._cache.get(cid)
        if not conv:
            return
        path = _CONV_DIR / f"{cid}.json"
        try:
            path.write_text(json.dumps(conv, indent=2, ensure_ascii=False), encoding="utf-8")
        except Exception as e:
            log.error(f"Failed to save conversation {cid}: {e}")
