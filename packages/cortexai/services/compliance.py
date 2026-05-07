import json
import logging
from datetime import datetime
from pathlib import Path
from typing import Dict, List, Optional

log = logging.getLogger("CortexAI")

_AUDIT_PATH = Path(__file__).parent.parent / "configs" / "audit.jsonl"


class ComplianceManager:
    def __init__(self):
        self._log: List[Dict] = []
        _AUDIT_PATH.parent.mkdir(parents=True, exist_ok=True)
        if _AUDIT_PATH.exists():
            for line in _AUDIT_PATH.read_text(encoding="utf-8").splitlines():
                try:
                    self._log.append(json.loads(line))
                except Exception:
                    pass

    def record(self, user: str, action: str, resource: str, region: Optional[str] = None):
        entry = {
            "timestamp": datetime.now().isoformat(),
            "user": user,
            "action": action,
            "resource": resource,
            "region": region,
        }
        self._log.append(entry)
        try:
            with open(_AUDIT_PATH, "a", encoding="utf-8") as f:
                f.write(json.dumps(entry) + "\n")
        except Exception as e:
            log.error(f"Failed to write audit log: {e}")
        log.debug(f"Audit: {entry}")

    def export(self, path: str):
        existing_path = Path(path)
        if existing_path.exists():
            ts = datetime.now().strftime("%Y%m%d_%H%M%S")
            stem = existing_path.stem
            suffix = existing_path.suffix
            path = str(existing_path.parent / f"{stem}_{ts}{suffix}")
        with open(path, "w", encoding="utf-8") as f:
            json.dump(self._log, f, indent=2)
        log.info(f"Audit log exported to {path}")

    def get_log(self) -> List[Dict]:
        return list(self._log)
