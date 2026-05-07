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

## Logs

Runtime logs are written to `cortexai.log` in the project root.
