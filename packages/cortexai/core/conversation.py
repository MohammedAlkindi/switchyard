from dataclasses import dataclass, field
from datetime import datetime
from typing import Any, Dict, Optional


@dataclass
class ConversationEntry:
    timestamp: datetime
    prompt: str
    response: str
    model_used: str
    metadata: Dict[str, Any] = field(default_factory=dict)
    summary: Optional[str] = None
