import json
from unittest.mock import MagicMock
from fastapi.testclient import TestClient
from api.server import create_api_app, estimate_tokens


def test_estimate_tokens():
    assert estimate_tokens("hello") >= 1
    assert estimate_tokens("a" * 100) == 25


def test_health_endpoint():
    app = create_api_app()
    client = TestClient(app)
    res = client.get("/health")
    assert res.status_code == 200
    data = res.json()
    assert data["status"] == "ok"
    assert data["service"] == "switchyard-cortexai-gateway"


def test_fleet_endpoints():
    app = create_api_app()
    client = TestClient(app)
    res = client.get("/fleet/status")
    assert res.status_code == 200
    assert "activeAgents" in res.json()

    res_agents = client.get("/fleet/agents")
    assert res_agents.status_code == 200
    assert res_agents.json()["ok"] is True


def test_models_endpoint():
    mock_core = MagicMock()
    mock_core.model_manager.list_models.return_value = ["local-llama"]
    app = create_api_app(mock_core)
    client = TestClient(app)
    res = client.get("/v1/models")
    assert res.status_code == 200
    model_ids = [m["id"] for m in res.json()["data"]]
    assert "gpt-4o" in model_ids
    assert "local-llama" in model_ids


def test_chat_completions_simulation_and_billing():
    mock_core = MagicMock()
    mock_core.anthropic_client.ready = False
    mock_core.openai_client.ready = False
    mock_core.billing.calculate_cost.return_value = 0.0001

    app = create_api_app(mock_core)
    client = TestClient(app)

    payload = {
        "model": "claude-sonnet-4-20250514",
        "messages": [{"role": "user", "content": "Hello fleet"}],
    }
    res = client.post("/v1/chat/completions", json=payload, headers={"x-fleet-agent": "agent-test"})
    assert res.status_code == 200
    data = res.json()
    assert data["object"] == "chat.completion"
    assert len(data["choices"]) == 1
    assert "usage" in data
    assert mock_core.billing.log_usage.called


def _sse_data(res):
    return [ln[len("data: "):] for ln in res.text.splitlines() if ln.startswith("data: ")]


def test_chat_completions_stream_simulation():
    mock_core = MagicMock()
    mock_core.anthropic_client.ready = False
    mock_core.openai_client.ready = False
    mock_core.billing.calculate_cost.return_value = 0.0
    client = TestClient(create_api_app(mock_core))
    # model with no matching prefix and no ready client falls back to the simulation
    res = client.post("/v1/chat/completions", json={"model": "local-x", "stream": True,
                      "messages": [{"role": "user", "content": "hi"}]})
    assert res.status_code == 200
    assert res.headers["content-type"].startswith("text/event-stream")
    events = _sse_data(res)
    assert events[-1] == "[DONE]"
    chunks = [json.loads(e) for e in events[:-1]]
    assert all(c["object"] == "chat.completion.chunk" for c in chunks)
    assert chunks[0]["choices"][0]["delta"] == {"role": "assistant"}
    assert chunks[-1]["choices"][0]["finish_reason"] == "stop"
    text = "".join(c["choices"][0]["delta"].get("content", "") for c in chunks)
    assert "Gateway Simulation" in text
    assert mock_core.billing.log_usage.called


def test_chat_completions_stream_uses_client_stream():
    def fake_stream(messages, system, model, max_tokens, on_token, stop_check):
        for t in ["Hel", "lo"]:
            on_token(t)

    mock_core = MagicMock()
    mock_core.anthropic_client.stream_chat.side_effect = fake_stream
    mock_core.billing.calculate_cost.return_value = 0.0
    client = TestClient(create_api_app(mock_core))
    res = client.post("/v1/chat/completions", json={"model": "claude-sonnet-4-20250514", "stream": True,
                      "messages": [{"role": "user", "content": "hi"}]})
    chunks = [json.loads(e) for e in _sse_data(res)[:-1]]
    text = "".join(c["choices"][0]["delta"].get("content", "") for c in chunks)
    assert text == "Hello"


def test_chat_completions_stream_error_event():
    mock_core = MagicMock()
    mock_core.anthropic_client.stream_chat.side_effect = RuntimeError("boom")
    client = TestClient(create_api_app(mock_core))
    res = client.post("/v1/chat/completions", json={"model": "claude-x", "stream": True,
                      "messages": [{"role": "user", "content": "hi"}]})
    events = _sse_data(res)
    assert "boom" in events[-2]
    assert events[-1] == "[DONE]"
