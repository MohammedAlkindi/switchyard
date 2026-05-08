import json
import importlib
import sys
import os
import tempfile
from pathlib import Path

sys.path.insert(0, os.path.dirname(os.path.dirname(__file__)))


def _make_manager(tmp_dir):
    import services.billing as mod
    importlib.reload(mod)  # reset module state first
    mod._BILLING_PATH = Path(tmp_dir) / "billing.jsonl"  # patch after reload, before creating manager
    return mod.BillingManager()


def test_log_usage_writes_to_file():
    with tempfile.TemporaryDirectory() as tmp:
        mgr = _make_manager(tmp)
        mgr.log_usage("user", "claude-sonnet-4", 100, 0.0003)
        mgr.close()
        path = Path(tmp) / "billing.jsonl"
        assert path.exists()
        record = json.loads(path.read_text().strip())
        assert record["user"] == "user"
        assert record["tokens"] == 100
        assert record["model"] == "claude-sonnet-4"


def test_get_report_all():
    with tempfile.TemporaryDirectory() as tmp:
        mgr = _make_manager(tmp)
        mgr.log_usage("alice", "model-a", 100, 0.01)
        mgr.log_usage("bob", "model-b", 200, 0.02)
        mgr.close()
        assert len(mgr.get_report()) == 2


def test_get_report_filters_by_user():
    with tempfile.TemporaryDirectory() as tmp:
        mgr = _make_manager(tmp)
        mgr.log_usage("alice", "model-a", 100, 0.01)
        mgr.log_usage("bob", "model-b", 200, 0.02)
        mgr.close()
        assert len(mgr.get_report("alice")) == 1
        assert mgr.get_report("alice")[0]["user"] == "alice"


def test_close_is_idempotent():
    with tempfile.TemporaryDirectory() as tmp:
        mgr = _make_manager(tmp)
        mgr.close()
        mgr.close()  # should not raise
