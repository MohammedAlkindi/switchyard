import subprocess
import sys
from pathlib import Path

import core.model_manager as mm

ROOT = Path(__file__).resolve().parent.parent


def test_importing_model_manager_does_not_load_torch_or_transformers():
    code = (
        "import sys; import core.model_manager; "
        "bad = [m for m in ('torch', 'transformers') if m in sys.modules]; "
        "print(','.join(bad)); sys.exit(1 if bad else 0)"
    )
    res = subprocess.run([sys.executable, "-I", "-c", "import sys; sys.path.insert(0, %r); " % str(ROOT) + code],
                         capture_output=True, text=True, timeout=120)
    assert res.returncode == 0, res.stdout + res.stderr


def test_has_transformers_probes_lazily(monkeypatch):
    calls = []

    def fake_init():
        calls.append(1)
        return True

    monkeypatch.setattr(mm, "_init_local_ml", fake_init)
    assert mm.has_transformers() is True
    assert calls == [1]
