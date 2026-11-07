import hashlib
import json
import logging
import os
import time
from datetime import datetime
from pathlib import Path
from typing import Any, Dict, List, Optional, Union

log = logging.getLogger("CortexAI")

try:
    from fastapi import FastAPI, Header, Request
    from fastapi.middleware.cors import CORSMiddleware
    from fastapi.responses import JSONResponse
    HAS_FASTAPI = True
except ImportError:
    HAS_FASTAPI = False


def find_fleet_state(start_dir: Optional[Path] = None) -> Optional[Dict[str, Any]]:
    """Look up the directory tree to find Switchyard's .fleet/state.json file."""
    curr = (start_dir or Path(__file__).resolve().parent).resolve()
    for _ in range(6):
        state_file = curr / ".fleet" / "state.json"
        if state_file.exists():
            try:
                return json.loads(state_file.read_text(encoding="utf-8"))
            except Exception as e:
                log.warning(f"Could not parse fleet state at {state_file}: {e}")
                return None
        if curr.parent == curr:
            break
        curr = curr.parent
    return None


def estimate_tokens(text: str) -> int:
    """Rough token count estimation (approx 4 chars per token)."""
    return max(1, len(text) // 4)


def create_api_app(ai_core: Optional[Any] = None) -> Any:
    if not HAS_FASTAPI:
        log.warning("FastAPI not installed. Run: pip install fastapi uvicorn")
        return None

    if ai_core is None:
        try:
            from core.ai_core import AICore
            ai_core = AICore()
        except Exception as e:
            log.warning(f"Could not initialize full AICore: {e}")
            ai_core = None

    app = FastAPI(
        title="Switchyard Fleet & CortexAI Gateway",
        description="Local OpenAI-compatible model proxy and fleet gateway for Switchyard coding agents.",
        version="1.1.0",
    )

    app.add_middleware(
        CORSMiddleware,
        allow_origins=["*"],
        allow_methods=["*"],
        allow_headers=["*"],
    )

    @app.get("/health")
    def health():
        return {
            "status": "ok",
            "service": "switchyard-cortexai-gateway",
            "timestamp": datetime.now().isoformat(),
        }

    @app.get("/fleet/agents")
    def list_fleet_agents():
        state = find_fleet_state()
        if not state:
            return {"ok": True, "agents": {}, "message": "No .fleet/state.json found"}
        return {"ok": True, "agents": state.get("agents", {})}

    @app.get("/fleet/status")
    def fleet_status():
        state = find_fleet_state()
        agents = state.get("agents", {}) if state else {}
        return {
            "ok": True,
            "activeAgents": len(agents),
            "agents": list(agents.keys()),
        }

    @app.get("/v1/models")
    def list_models():
        default_models = [
            {"id": "claude-sonnet-4-20250514", "object": "model", "owned_by": "anthropic"},
            {"id": "claude-opus-4", "object": "model", "owned_by": "anthropic"},
            {"id": "claude-haiku-4", "object": "model", "owned_by": "anthropic"},
            {"id": "gpt-4o", "object": "model", "owned_by": "openai"},
            {"id": "gpt-4o-mini", "object": "model", "owned_by": "openai"},
        ]
        if ai_core and hasattr(ai_core, "model_manager"):
            extra = ai_core.model_manager.list_models()
            for m in extra:
                default_models.append({"id": m, "object": "model", "owned_by": "local"})
        return {"object": "list", "data": default_models}

    @app.post("/v1/chat/completions")
    async def chat_completions(request: Request, x_fleet_agent: Optional[str] = Header(None)):
        body = await request.json()
        model = body.get("model", "claude-sonnet-4-20250514")
        messages = body.get("messages", [])
        max_tokens = body.get("max_tokens", 2048)
        temperature = body.get("temperature", 0.7)
        agent_id = x_fleet_agent or body.get("user", "fleet-agent")

        prompt_text = " ".join([m.get("content", "") for m in messages if isinstance(m.get("content"), str)])
        prompt_tokens = estimate_tokens(prompt_text)

        response_text = ""
        try:
            if model.startswith("claude-") and ai_core and hasattr(ai_core, "anthropic_client"):
                response_text = ai_core.anthropic_client.chat(messages, model=model, max_tokens=max_tokens)
            elif (model.startswith("gpt-") or model.startswith("o1") or model.startswith("o3")) and ai_core and hasattr(ai_core, "openai_client"):
                response_text = ai_core.openai_client.chat(messages, model=model, max_tokens=max_tokens)
            elif ai_core and hasattr(ai_core, "anthropic_client") and ai_core.anthropic_client.ready:
                response_text = ai_core.anthropic_client.chat(messages, model=model, max_tokens=max_tokens)
            elif ai_core and hasattr(ai_core, "openai_client") and ai_core.openai_client.ready:
                response_text = ai_core.openai_client.chat(messages, model=model, max_tokens=max_tokens)
            else:
                response_text = f"[Switchyard Gateway Simulation] Responding from model {model} for agent {agent_id}."

            completion_tokens = estimate_tokens(response_text)
            total_tokens = prompt_tokens + completion_tokens

            # Meter usage and cost via contextbill-synchronized billing manager
            if ai_core and hasattr(ai_core, "billing"):
                cost = ai_core.billing.calculate_cost(model, prompt_tokens, completion_tokens)
                ai_core.billing.log_usage(agent_id, model, total_tokens, cost)

            chat_id = f"chatcmpl-{hashlib.md5((prompt_text + str(time.time())).encode()).hexdigest()[:12]}"
            return {
                "id": chat_id,
                "object": "chat.completion",
                "created": int(time.time()),
                "model": model,
                "choices": [
                    {
                        "index": 0,
                        "message": {
                            "role": "assistant",
                            "content": response_text,
                        },
                        "finish_reason": "stop",
                    }
                ],
                "usage": {
                    "prompt_tokens": prompt_tokens,
                    "completion_tokens": completion_tokens,
                    "total_tokens": total_tokens,
                },
            }
        except Exception as e:
            log.error(f"Chat completion error: {e}", exc_info=True)
            return JSONResponse(status_code=500, content={"error": {"message": str(e), "type": "gateway_error"}})

    @app.post("/v1/completions")
    async def legacy_completions(request: Request, x_fleet_agent: Optional[str] = Header(None)):
        body = await request.json()
        prompt = body.get("prompt", "")
        model = body.get("model", "claude-sonnet-4-20250514")
        max_tokens = body.get("max_tokens", 1024)
        agent_id = x_fleet_agent or body.get("user", "fleet-agent")

        messages = [{"role": "user", "content": prompt}]
        prompt_tokens = estimate_tokens(prompt)

        try:
            if ai_core and hasattr(ai_core, "anthropic_client") and ai_core.anthropic_client.ready:
                response_text = ai_core.anthropic_client.chat(messages, model=model, max_tokens=max_tokens)
            elif ai_core and hasattr(ai_core, "openai_client") and ai_core.openai_client.ready:
                response_text = ai_core.openai_client.chat(messages, model=model, max_tokens=max_tokens)
            else:
                response_text = f"[Switchyard Gateway Simulation] Completion for model {model}."

            completion_tokens = estimate_tokens(response_text)
            total_tokens = prompt_tokens + completion_tokens

            if ai_core and hasattr(ai_core, "billing"):
                cost = ai_core.billing.calculate_cost(model, prompt_tokens, completion_tokens)
                ai_core.billing.log_usage(agent_id, model, total_tokens, cost)

            cmpl_id = f"cmpl-{hashlib.md5(prompt.encode()).hexdigest()[:8]}"
            return {
                "id": cmpl_id,
                "object": "text_completion",
                "created": int(time.time()),
                "model": model,
                "choices": [{"text": response_text, "index": 0, "finish_reason": "stop"}],
                "usage": {
                    "prompt_tokens": prompt_tokens,
                    "completion_tokens": completion_tokens,
                    "total_tokens": total_tokens,
                },
            }
        except Exception as e:
            log.error(f"Completions error: {e}", exc_info=True)
            return JSONResponse(status_code=500, content={"error": {"message": str(e), "type": "gateway_error"}})

    return app


# Module-level app instance for `uvicorn api.server:app`
app = create_api_app()
