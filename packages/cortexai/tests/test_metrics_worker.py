import sys
import os
from datetime import datetime

sys.path.insert(0, os.path.dirname(os.path.dirname(__file__)))

from PyQt5.QtCore import Qt, pyqtSignal
from PyQt5.QtWidgets import QApplication

_app = QApplication.instance() or QApplication([])


def test_metrics_worker_has_signal():
    from core.metrics_worker import MetricsWorker
    assert hasattr(MetricsWorker, "metrics_ready")


def test_metrics_worker_can_be_created():
    from core.metrics_worker import MetricsWorker
    worker = MetricsWorker("/", datetime.now())
    assert worker is not None
    worker.terminate()
    worker.wait(500)


def test_metrics_worker_signal_connectable():
    from core.metrics_worker import MetricsWorker
    results = []
    worker = MetricsWorker("/", datetime.now())
    worker.metrics_ready.connect(results.append, Qt.DirectConnection)
    # Just verify connection works without starting the thread
    assert worker is not None
    worker.terminate()
    worker.wait(500)
