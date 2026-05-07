import logging
from datetime import datetime
from typing import Dict

log = logging.getLogger("CortexAI")


class RateLimiter:
    def __init__(self, max_per_minute: int = 60):
        self._max = max_per_minute
        self._counts: Dict[str, Dict] = {}

    def allow(self, user: str) -> bool:
        now = datetime.now().replace(second=0, microsecond=0)
        user_data = self._counts.setdefault(user, {})
        user_data[now] = user_data.get(now, 0) + 1
        for key in list(user_data):
            if key != now:
                del user_data[key]
        if user_data[now] > self._max:
            log.warning(f"Rate limit exceeded for user: {user}")
            return False
        return True
