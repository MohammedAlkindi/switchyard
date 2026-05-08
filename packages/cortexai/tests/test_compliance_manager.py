import json
import tempfile
from pathlib import Path


def _make_manager(tmp):
    audit_path = Path(tmp) / "audit.jsonl"
    import importlib
    import services.compliance as mod
    importlib.reload(mod)
    mod._AUDIT_PATH = audit_path
    return mod.ComplianceManager(), audit_path


def test_record_writes_to_file():
    with tempfile.TemporaryDirectory() as tmp:
        mgr, audit_path = _make_manager(tmp)
        mgr.record("alice", "chat", "claude-sonnet")
        assert audit_path.exists()
        lines = audit_path.read_text(encoding="utf-8").splitlines()
        assert len(lines) == 1
        entry = json.loads(lines[0])
        assert entry["user"] == "alice"
        assert entry["action"] == "chat"
        mgr.close()


def test_multiple_records_append():
    with tempfile.TemporaryDirectory() as tmp:
        mgr, audit_path = _make_manager(tmp)
        mgr.record("alice", "chat", "model-a")
        mgr.record("bob", "export", "model-b")
        lines = audit_path.read_text(encoding="utf-8").splitlines()
        assert len(lines) == 2
        mgr.close()


def test_export_creates_json():
    with tempfile.TemporaryDirectory() as tmp:
        mgr, _ = _make_manager(tmp)
        mgr.record("alice", "action", "resource")
        out = str(Path(tmp) / "export.json")
        actual = mgr.export(out)
        assert actual == out
        data = json.loads(Path(out).read_text(encoding="utf-8"))
        assert len(data) == 1
        assert data[0]["user"] == "alice"
        mgr.close()


def test_get_log():
    with tempfile.TemporaryDirectory() as tmp:
        mgr, _ = _make_manager(tmp)
        mgr.record("user1", "a", "r")
        mgr.record("user2", "b", "r")
        log = mgr.get_log()
        assert len(log) == 2
        mgr.close()


def test_close_is_idempotent():
    with tempfile.TemporaryDirectory() as tmp:
        mgr, _ = _make_manager(tmp)
        mgr.close()
        mgr.close()  # should not raise
