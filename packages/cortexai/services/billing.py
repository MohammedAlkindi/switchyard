import json
from datetime import datetime
from typing import Dict, List, Optional


class BillingManager:
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
