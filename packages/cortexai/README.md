# CortexAI

A modular AI chat desktop application built with PyQt5, supporting Claude (Anthropic) and OpenAI models with a built-in REST API, analytics dashboard, and optional local model inference.

## Features

- **Chat** — conversational interface powered by Anthropic Claude or OpenAI
- **Analytics** — real-time system metrics (CPU, memory, network, GPU)
- **Local models** — optional translation, sentiment analysis, and summarization via Hugging Face Transformers
- **REST API** — FastAPI server exposing `/v1/completions` and `/v1/models`
- **Audit log** — exportable compliance log of all interactions
- **Plugin system** — extensible plugin loader

## Requirements

- Python 3.13+
- Windows / macOS / Linux

## Setup

1. **Clone the repo**
   ```bash
   git clone <repo-url>
   cd CortexAI
   ```

2. **Install dependencies**
   ```bash
   python -m pip install -r requirements.txt
   ```

3. **Configure environment**

   Copy `.env.example` to `.env` and fill in your API keys:
   ```bash
   cp .env.example .env
   ```

   ```env
   ANTHROPIC_API_KEY=your_anthropic_key
   OPENAI_API_KEY=your_openai_key
   ```

4. **Run**
   ```bash
   python main.py
   ```

## Environment Variables

| Variable | Default | Description |
|---|---|---|
| `ANTHROPIC_API_KEY` | — | Anthropic API key (required for Claude) |
| `OPENAI_API_KEY` | — | OpenAI API key |
| `CORTEXAI_LOG_LEVEL` | `INFO` | Log verbosity (`DEBUG`, `INFO`, `WARNING`) |
| `CORTEXAI_MAX_TOKENS` | `2048` | Max tokens per request |
| `CORTEXAI_API_PORT` | `8000` | Port for the built-in FastAPI server |

## Optional Features

| Feature | Extra install |
|---|---|
| Local model inference | `pip install torch transformers` |
| Conversation encryption | `pip install cryptography` |
| NVIDIA GPU monitoring | `pip install pynvml` |

## Architecture Overview

```
main.py
├── AICore (core/ai_core.py)
│   ├── AnthropicClient (clients/anthropic_client.py)
│   ├── OpenAIClient (clients/openai_client.py)
│   ├── MetricsWorker (core/metrics_worker.py)
│   ├── ComplianceManager (services/compliance.py)
│   ├── BillingManager (services/billing.py)
│   └── PluginManager (services/plugin_manager.py)
└── MainWindow (ui/main_window.py)
    ├── ChatTab → ConversationStore (core/conversation_store.py)
    ├── AnalyticsTab
    ├── SettingsTab → user_settings (core/user_settings.py)
    └── PluginsTab
```

## Project Structure

```
CortexAI/
├── main.py              # Entry point
├── core/                # AI engine, model manager, conversation history
├── ui/                  # PyQt5 windows and tabs (chat, analytics, docs)
├── clients/             # Anthropic and OpenAI API clients
├── services/            # Billing, compliance, rate limiting, plugins
├── api/                 # FastAPI REST server
└── configs/             # YAML config and encryption key (auto-generated)
```

## Keyboard Shortcuts

| Shortcut | Action |
|---|---|
| `Ctrl+N` | New conversation |
| `Ctrl+K` | Switch model |
| `Ctrl+,` | Open settings |
| `Ctrl+L` | Clear conversation |
| `Ctrl+E` | Export conversation |
| `Ctrl+F` | Search in conversation |
| `Ctrl+/` | Show all shortcuts |
| `Enter` | Send message |
| `Shift+Enter` | New line |
| `Escape` | Stop generation |

## Supported Models

| Provider  | Model              | Use case              |
|-----------|--------------------|-----------------------|
| Anthropic | claude-opus-4      | Complex reasoning     |
| Anthropic | claude-sonnet-4    | Everyday use          |
| Anthropic | claude-haiku-4     | Fast, simple tasks    |
| OpenAI    | gpt-4o             | Alternative provider  |
| OpenAI    | gpt-4o-mini        | Fast OpenAI option    |
| Auto      | Smart Routing      | Best model per task   |

## Adding a custom display name

Open Settings → Appearance → Display Name and enter your name. This
personalises the greeting on the chat empty state.

## REST API

When FastAPI + uvicorn are installed (`pip install fastapi uvicorn[standard]`), CortexAI starts a local REST server on port 8000:

```bash
curl http://localhost:8000/v1/models
curl -X POST http://localhost:8000/v1/completions \
  -H "Content-Type: application/json" \
  -d '{"prompt": "Hello", "model": "claude-sonnet-4-20250514"}'
```

Swagger UI: http://localhost:8000/docs

## Building a Release (Windows)

```bash
pip install pyinstaller
pyinstaller CortexAI.spec
# Output: dist/CortexAI.exe
```

## Tests

```bash
pip install pytest pytest-qt pytest-mock
pytest
```

## Logs

Runtime logs are written to `logs/cortexai.log`.
