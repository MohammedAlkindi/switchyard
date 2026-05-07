# CortexAI

A modular AI chat desktop app built with PyQt5. Supports Claude and OpenAI, with a FastAPI REST layer, analytics dashboard, audit logging, and a plugin system.

## Architecture

```
main.py              # Entry point — loads env, wires up app
core/                # AI engine, model manager, conversation history
clients/             # Anthropic and OpenAI API clients (shared interface)
services/            # Billing, compliance, rate limiting, plugins
api/                 # FastAPI REST server (/v1/completions, /v1/models)
ui/                  # PyQt5 windows and tabs (chat, analytics, docs)
plugins/             # Drop-in plugin files (auto-discovered at runtime)
configs/             # Auto-generated at runtime — not committed, do not edit manually
monolithic/          # Legacy single-file version — kept for reference only, not active code
```

## Key conventions

- All API clients in `clients/` must implement the same shared interface — do not add provider-specific logic to `core/`
- Environment variables are loaded via `python-dotenv` at startup in `main.py` — never hardcode keys
- The audit log must be append-only — never modify or delete existing entries
- Optional features (torch, cryptography, pynvml) are imported conditionally — always guard with try/except ImportError

## Environment variables

| Variable | Default | Description |
|---|---|---|
| ANTHROPIC_API_KEY | — | Required for Claude |
| OPENAI_API_KEY | — | Required for OpenAI |
| CORTEXAI_LOG_LEVEL | INFO | DEBUG / INFO / WARNING |
| CORTEXAI_MAX_TOKENS | 2048 | Max tokens per request |
| CORTEXAI_API_PORT | 8000 | FastAPI server port |

## Running locally

```bash
python -m pip install -r requirements.txt
cp .env.example .env   # fill in API keys
python main.py
```

## Tests

```bash
pip install pytest pytest-qt
pytest
```

Tests live in `tests/` — run them before any PR.

## Adding a new AI provider

1. Create `clients/yournewprovider_client.py`
2. Implement the shared client interface (see existing clients for reference)
3. Register it in `core/model_manager.py`
4. Do not add provider logic anywhere else

## Adding a plugin

Plugins are `.py` files placed in `plugins/` at the project root. The plugin manager discovers and loads them automatically at startup.

Each plugin file must expose a top-level `initialize(host)` function that returns the plugin object:

```python
def initialize(host):
    # host gives access to the app; return the plugin instance
    return MyPlugin(host)
```

## REST API

FastAPI server runs on port 8000 by default.
- `POST /v1/completions` — generate a completion
- `GET /v1/models` — list available models
- Swagger UI available at `http://localhost:8000/docs`

## Known legacy files (do not use)

- `monolithic/CortexAI.py` — legacy single-file reference, not active code

## Persistence layer

- Conversations: `configs/conversations/{uuid}.json`
- Audit log: `configs/audit.jsonl` (append-only JSONL, never overwrite)
- Billing: `configs/billing.jsonl` (append-only JSONL)
- User settings: `configs/user_settings.json`
- All `configs/` files are runtime-generated and gitignored

## Signal conventions

- UI widgets emit signals — they do NOT call business logic directly
- `ai_core` signals flow: `AICore` → UI (one direction)
- Conversation updates: `ChatTab.conversation_updated(dict)` → `MainWindow` → `Sidebar`

## Threading rules

- All Anthropic API calls must happen in a `QThread` subclass (`StreamingChatWorker`)
- Never call `psutil` blocking methods on the main thread — use `MetricsWorker`
- `QTimer` callbacks run on the main thread — keep them under 5ms
- `ConversationStore` uses a 2-second write-debounce — do not call `_save()` directly

## What not to do

- Do not edit files in `configs/` — they are auto-generated at runtime
- Do not treat `monolithic/CortexAI.py` as authoritative — it is legacy reference code
- Do not add UI logic to `core/` or `clients/`
- Do not catch and silently swallow exceptions — log them
- Do not commit `.env` or any file containing real API keys
