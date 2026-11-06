import json
import logging
from datetime import datetime
from pathlib import Path
from typing import Dict, List, Optional

log = logging.getLogger("CortexAI")

_BILLING_PATH = Path(__file__).parent.parent / "configs" / "billing.jsonl"
_PRICES_PATH = Path(__file__).resolve().parent.parent.parent / "contextbill" / "prices.json"


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
        try:
            self._file_handle = open(_BILLING_PATH, "a", encoding="utf-8")
        except Exception as e:
            log.error(f"Failed to open billing log: {e}")
            self._file_handle = None

    def get_model_rate(self, model: str) -> Dict[str, float]:
        """Look up per-million-token input/output rates, prioritizing contextbill's prices.json."""
        if _PRICES_PATH.exists():
            try:
                data = json.loads(_PRICES_PATH.read_text(encoding="utf-8"))
                models = data.get("models", {})
                norm_model = model.lower()
                for key, rates in models.items():
                    if key.lower() in norm_model or norm_model in key.lower():
                        return {"input": float(rates.get("input", 3.0)), "output": float(rates.get("output", 15.0))}
            except Exception as e:
                log.debug(f"Could not load rates from contextbill prices.json: {e}")
        return {"input": 3.0, "output": 15.0}

    def calculate_cost(self, model: str, input_tokens: int, output_tokens: int) -> float:
        """Calculate total USD cost for a token count given the model rates."""
        rates = self.get_model_rate(model)
        input_cost = (input_tokens / 1_000_000.0) * rates["input"]
        output_cost = (output_tokens / 1_000_000.0) * rates["output"]
        return round(input_cost + output_cost, 6)

    def log_usage(self, user: str, model: str, tokens: int, cost: float):
        record = {
            "timestamp": datetime.now().isoformat(),
            "user": user,
            "model": model,
            "tokens": tokens,
            "cost": cost,
        }
        self._records.append(record)
        if self._file_handle:
            try:
                self._file_handle.write(json.dumps(record) + "\n")
                self._file_handle.flush()
            except Exception as e:
                log.error(f"Failed to write billing record: {e}")

    def get_report(self, user: Optional[str] = None) -> List[Dict]:
        if user:
            return [r for r in self._records if r["user"] == user]
        return list(self._records)

    def export(self, path: str):
        with open(path, "w", encoding="utf-8") as f:
            json.dump(self._records, f, indent=2)

    def close(self):
        if self._file_handle and not self._file_handle.closed:
            self._file_handle.close()
            self._file_handle = None
