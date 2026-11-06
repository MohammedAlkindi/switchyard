import threading
from datetime import datetime

from PyQt5.QtCore import QThread, pyqtSignal


class MetricsWorker(QThread):
    metrics_ready = pyqtSignal(dict)

    def __init__(self, disk_path: str, start_time: datetime, parent=None):
        super().__init__(parent)
        self._disk_path = disk_path
        self._start_time = start_time

    def run(self):
        import psutil
        _has_nvml = False
        try:
            import pynvml  # noqa: F401
            _has_nvml = True
        except ImportError:
            pass

        while not self.isInterruptionRequested():
            metrics = {
                "timestamp": datetime.now().isoformat(),
                "cpu": psutil.cpu_percent(),
                "memory": psutil.virtual_memory().percent,
                "threads": threading.active_count(),
                "uptime_s": (datetime.now() - self._start_time).total_seconds(),
            }
            try:
                metrics["disk"] = psutil.disk_usage(self._disk_path).percent
            except Exception:
                metrics["disk"] = 0
            try:
                net = psutil.net_io_counters()
                metrics["net_sent_mb"] = round(net.bytes_sent / 1e6, 2)
                metrics["net_recv_mb"] = round(net.bytes_recv / 1e6, 2)
            except Exception:
                pass
            if _has_nvml:
                try:
                    import pynvml as nvml
                    nvml.nvmlInit()
                    handle = nvml.nvmlDeviceGetHandleByIndex(0)
                    info = nvml.nvmlDeviceGetMemoryInfo(handle)
                    nvml.nvmlShutdown()
                    metrics["gpu"] = (info.used / info.total) * 100
                except Exception:
                    pass
            self.metrics_ready.emit(metrics)
            self.msleep(5000)
