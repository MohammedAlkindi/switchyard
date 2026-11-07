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
