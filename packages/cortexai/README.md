# CortexAI

> **Monorepo Notice:** CortexAI is maintained as part of the [Switchyard](https://github.com/MohammedAlkindi/switchyard) multi-agent workspace. It provides the desktop chat workspace and local model gateway (`/v1/completions`) for Switchyard agents, with pricing synchronized from `packages/contextbill`.

A modular AI chat desktop application built with PyQt5, supporting Claude (Anthropic) and OpenAI models with a built-in REST API, analytics dashboard, and optional local model inference.

## Features

- **Chat** — conversational interface powered by Anthropic Claude or OpenAI
- **Analytics** — real-time system metrics (CPU, memory, network, GPU)
- **Local models** — optional translation, sentiment analysis, and summarization via Hugging Face Transformers
- **REST API** — FastAPI server exposing `/v1/completions` and `/v1/models`
- **Audit log** — exportable compliance log of all interactions
- **Plugin system** — extensible plugin loader
- **Switchyard Integration** — model cost metering unified with `@switchyardhq/contextbill`

## Requirements

- Python 3.13+
- Windows / macOS / Linux

## Setup

1. **Install dependencies**
   ```bash
   pip install -r requirements.txt
   ```

2. **Configure environment**

   Copy `.env.example` to `.env` and fill in your API keys:
   ```bash
   cp .env.example .env
   ```

   ```env
   ANTHROPIC_API_KEY=your_anthropic_key
   OPENAI_API_KEY=your_openai_key
   ```

3. **Run Desktop App**
   ```bash
   python main.py
   ```

4. **Run Local API Gateway**
   ```bash
   uvicorn api.server:create_api_app --port 8000
   ```
