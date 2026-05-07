import hashlib
import logging
import time
from datetime import datetime
from typing import TYPE_CHECKING

if TYPE_CHECKING:
    from cortexai.core.ai_core import AICore

log = logging.getLogger("CortexAI")

try:
    from fastapi import FastAPI, Request
    from fastapi.middleware.cors import CORSMiddleware
    from fastapi.responses import JSONResponse
    HAS_FASTAPI = True
except ImportError:
    HAS_FASTAPI = False


def create_api_app(ai_core: "AICore"):
    if not HAS_FASTAPI:
        return None

    app = FastAPI(title="CortexAI API", version="1.0.0")
    app.add_middleware(
        CORSMiddleware,
        allow_origins=["*"],
        allow_methods=["*"],
        allow_headers=["*"],
    )

    @app.get("/health")
    def health():
        return {"status": "ok", "timestamp": datetime.now().isoformat()}

    @app.get("/v1/models")
    def list_models():
        return {"models": ai_core.model_manager.list_models()}

    @app.post("/v1/completions")
    async def completions(request: Request):
        body = await request.json()
        prompt = body.get("prompt", "")
        model = body.get("model", "default")
        return {
            "id": f"cmpl-{hashlib.md5(prompt.encode()).hexdigest()[:8]}",
            "object": "text_completion",
            "created": int(time.time()),
            "model": model,
            "choices": [{"text": f"[CortexAI] {prompt[:100]}...", "index": 0, "finish_reason": "stop"}],
        }

    @app.exception_handler(Exception)
    async def error_handler(request: Request, exc: Exception):
        log.error(f"API error: {exc}", exc_info=True)
        return JSONResponse(status_code=500, content={"error": str(exc)})

    return app
