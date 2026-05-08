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
pip install pytest pytest-qt pytest-mock
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
- All OpenAI API calls must happen in `OpenAIStreamingWorker` in `clients/openai_client.py`
- Never call `psutil` blocking methods on the main thread — use `MetricsWorker`
- `QTimer` callbacks run on the main thread — keep them under 5ms
- `ConversationStore` uses a 2-second write-debounce — do not call `_save()` directly

## Module: core/metrics_worker.py

`MetricsWorker` runs system metric collection in a background `QThread`.
It is started by `AICore._setup_telemetry_timer()` and must be stopped
in `MainWindow.closeEvent()` via `requestInterruption()` + `wait()`.

## Module: core/user_settings.py

Centralised settings persistence. Both `ui/tabs/settings_tab.py` and
`ui/tabs/chat_tab.py` must import from here — never cross-import between
UI tab files.

## OpenAI routing

When `model_id` starts with `"gpt-"`, `ChatTab._start_worker` routes to
`OpenAIStreamingWorker` in `clients/openai_client.py`. The shared signal
interface (`token_ready`, `finished_ok`, `error_occurred`) must be maintained
by all provider workers.

## App shutdown sequence

`MainWindow.closeEvent`:
1. `MetricsWorker.requestInterruption()` + `wait(2000)`
2. `ConversationStore._flush_dirty()` — write any pending conversations
3. `ComplianceManager.close()` — flush audit file handle
4. `BillingManager.close()` — flush billing file handle
5. `event.accept()`

## Display name caching

`ui/tabs/chat_tab._CACHED_DISPLAY_NAME` is a module-level cache.
Invalidate it in `MainWindow._on_settings_changed` when display_name changes.

## API Key persistence

API keys entered in Settings → API Keys are stored in `configs/user_settings.json`
under the key `"anthropic_api_key"`. This file is gitignored. Prefer using `.env`
for keys as it is loaded at startup and is more portable.

The `AnthropicClient` build order:
1. Explicit `api_key` argument
2. `ANTHROPIC_API_KEY` environment variable (removed from env after reading)
3. `configs/user_settings.json` → `anthropic_api_key`

## Search implementation

`ChatTab` maintains `_search_results` (list of message indices), `_search_cursor`
(current position), and `_search_query` (active query). These are reset on every
`new_conversation()` and `load_conversation()`.

The `ConvSearchBar` emits three signals:
- `search_changed(str)` — text changed
- `next_requested()` — ▼ button or Enter key
- `prev_requested()` — ▲ button

## Markdown table support

`ui/components/markdown_renderer.py` supports: headings, bold, italic, code blocks,
inline code, links, lists (ordered + unordered, 2-level nesting), blockquotes,
horizontal rules, and tables. Tables require a separator row (|---|---| format).

## OpenAI routing (updated)

OpenAI API key is currently only supported via environment variable `OPENAI_API_KEY`.
It is NOT persisted to `user_settings.json` (only the Anthropic key is persisted).
Add OpenAI key persistence to `_ApiKeysPanel._save_oai` following the same pattern
as `_save_ant`.

## What not to do

- Do not edit files in `configs/` — they are auto-generated at runtime
- Do not treat `monolithic/CortexAI.py` as authoritative — it is legacy reference code
- Do not add UI logic to `core/` or `clients/`
- Do not catch and silently swallow exceptions — log them
- Do not commit `.env` or any file containing real API keys
- Do not commit `configs/user_settings.json` — it may contain API keys
