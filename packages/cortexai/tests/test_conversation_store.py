import tempfile
from pathlib import Path

import pytest


def _make_store(tmp):
    """Return a fresh ConversationStore backed by a temp directory."""
    import importlib
    import core.conversation_store as mod
    importlib.reload(mod)
    mod._CONV_DIR = Path(tmp)
    return mod.ConversationStore()


def test_create_and_get():
    with tempfile.TemporaryDirectory() as tmp:
        store = _make_store(tmp)
        conv = store.create()
        assert conv["title"] == "New conversation"
        assert store.get(conv["id"]) is not None


def test_add_message_autotitles():
    with tempfile.TemporaryDirectory() as tmp:
        store = _make_store(tmp)
        conv = store.create()
        store.add_message(conv["id"], "user", "Hello world, how are you?")
        # Flush dirty to disk immediately for test reliability
        store._flush_dirty()
        updated = store.get(conv["id"])
        assert updated["title"] == "Hello world, how are you?"


def test_delete():
    with tempfile.TemporaryDirectory() as tmp:
        store = _make_store(tmp)
        conv = store.create()
        cid = conv["id"]
        store.delete(cid)
        assert store.get(cid) is None


def test_corrupt_file_renamed_to_bak():
    with tempfile.TemporaryDirectory() as tmp:
        p = Path(tmp) / "bad.json"
        p.write_text("{not valid json", encoding="utf-8")
        store = _make_store(tmp)
        bak = Path(tmp) / "bad.json.bak"
        assert bak.exists(), "Corrupt file should have been renamed to .bak"
        assert not p.exists()


def test_list_recent_sorted():
    with tempfile.TemporaryDirectory() as tmp:
        store = _make_store(tmp)
        c1 = store.create()
        import time; time.sleep(0.01)
        c2 = store.create()
        recent = store.list_recent()
        assert recent[0]["id"] == c2["id"]


def test_rename():
    with tempfile.TemporaryDirectory() as tmp:
        store = _make_store(tmp)
        conv = store.create()
        store.rename(conv["id"], "My renamed title")
        store._flush_dirty()
        updated = store.get(conv["id"])
        assert updated["title"] == "My renamed title"
