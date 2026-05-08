import json
from pathlib import Path

_SETTINGS_PATH = Path("configs/user_settings.json")

_DEFAULTS = {
    "max_tokens": 2048,
    "temperature": 0.7,
    "default_model": "claude-sonnet-4-20250514",
    "system_prompt": "",
    "display_name": "",
    "features": {},
}


def load_user_settings() -> dict:
    if _SETTINGS_PATH.exists():
        try:
            return json.loads(_SETTINGS_PATH.read_text(encoding="utf-8"))
        except Exception:
            pass
    return dict(_DEFAULTS)


def save_user_settings(settings: dict) -> None:
    _SETTINGS_PATH.parent.mkdir(parents=True, exist_ok=True)
    _SETTINGS_PATH.write_text(
        json.dumps(settings, indent=2, ensure_ascii=False), encoding="utf-8"
    )
