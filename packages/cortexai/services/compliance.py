import json
import logging
from datetime import datetime
from typing import Dict, List, Optional

log = logging.getLogger("CortexAI")


class ComplianceManager:
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
