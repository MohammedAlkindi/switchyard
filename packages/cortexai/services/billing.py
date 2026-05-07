import json
import logging
from datetime import datetime
from pathlib import Path
from typing import Dict, List, Optional

log = logging.getLogger("CortexAI")

_BILLING_PATH = Path(__file__).parent.parent / "configs" / "billing.jsonl"


class BillingManager:
    def __init__(self):
        self._records: List[Dict] = []
        _BILLING_PATH.parent.mkdir(parents=True, exist_ok=True)
        if _BILLING_PATH.exists():
            for line in _BILLING_PATH.read_text(encoding="utf-8").splitlines():
                try:
                    self._records.append(json.loads(line))
                except Exception:
                    pass

    def log_usage(self, user: str, model: str, tokens: int, cost: float):
        record = {
            "timestamp": datetime.now().isoformat(),
            "user": user,
            "model": model,
            "tokens": tokens,
            "cost": cost,
        }
        self._records.append(record)
        try:
            with open(_BILLING_PATH, "a", encoding="utf-8") as f:
                f.write(json.dumps(record) + "\n")
        except Exception as e:
            log.error(f"Failed to write billing record: {e}")

    def get_report(self, user: Optional[str] = None) -> List[Dict]:
        if user:
            return [r for r in self._records if r["user"] == user]
        return list(self._records)

    def export(self, path: str):
        with open(path, "w", encoding="utf-8") as f:
            json.dump(self._records, f, indent=2)
