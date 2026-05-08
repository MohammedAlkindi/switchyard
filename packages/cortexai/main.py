import logging
import os
import sys
import time
from pathlib import Path


def _ensure_dirs():
    """Create required runtime directories for packaged app."""
    for d in ["configs", "configs/conversations", "plugins", "logs"]:
        Path(d).mkdir(parents=True, exist_ok=True)


def _start_api_server(ai_core, port: int):
    """Start FastAPI server in a background thread."""
    try:
        import uvicorn
        from api.server import create_api_app
        api_app = create_api_app(ai_core)
        if api_app:
            import threading
            t = threading.Thread(
                target=uvicorn.run,
                kwargs={"app": api_app, "host": "127.0.0.1", "port": port, "log_level": "warning"},
                daemon=True,
            )
            t.start()
            log_inst = logging.getLogger("CortexAI")
            log_inst.info(f"FastAPI server started on port {port}")
    except ImportError:
        logging.getLogger("CortexAI").info("uvicorn not installed — REST API disabled")
    except Exception as e:
        logging.getLogger("CortexAI").warning(f"FastAPI server failed to start: {e}")

try:
    from dotenv import load_dotenv
    load_dotenv()
except ImportError:
    pass

from PyQt5.QtWidgets import QApplication, QMessageBox
from PyQt5.QtCore import Qt

import ui.theme as T


def setup_logging() -> logging.Logger:
    logger = logging.getLogger("CortexAI")
    if logger.handlers:
        return logger
    level = getattr(logging, os.environ.get("CORTEXAI_LOG_LEVEL", "DEBUG").upper(), logging.DEBUG)
    logger.setLevel(level)
    fmt = logging.Formatter("%(asctime)s [%(levelname)s] %(name)s: %(message)s")
    ch = logging.StreamHandler()
    ch.setLevel(logging.INFO)
    ch.setFormatter(fmt)
    fh = logging.FileHandler("logs/cortexai.log", encoding="utf-8")
    fh.setLevel(logging.DEBUG)
    fh.setFormatter(fmt)
    logger.addHandler(ch)
    logger.addHandler(fh)
    return logger


def _load_stylesheet() -> str:
    qss_path = Path(__file__).parent / "ui" / "styles.qss"
    if qss_path.exists():
        return qss_path.read_text(encoding="utf-8")
    return ""


def main():
    _ensure_dirs()
    log = setup_logging()

    # Keep physical pixel sizes matching design specs on scaled Windows displays
    os.environ.setdefault("QT_SCALE_FACTOR", "1")

    QApplication.setAttribute(Qt.AA_UseHighDpiPixmaps)

    app = QApplication(sys.argv)
    app.setApplicationName("CortexAI")
    app.setApplicationVersion("1.0")
    app.setStyle("Fusion")

    T.init_fonts()

    from PyQt5.QtGui import QPalette, QColor
    palette = QPalette()
    palette.setColor(QPalette.Window,          QColor(T.BG_BASE))
    palette.setColor(QPalette.WindowText,      QColor(T.TEXT_PRIMARY))
    palette.setColor(QPalette.Base,            QColor(T.BG_ELEVATED))
    palette.setColor(QPalette.AlternateBase,   QColor(T.BG_SURFACE))
    palette.setColor(QPalette.Text,            QColor(T.TEXT_PRIMARY))
    palette.setColor(QPalette.Button,          QColor(T.BG_ELEVATED))
    palette.setColor(QPalette.ButtonText,      QColor(T.TEXT_PRIMARY))
    palette.setColor(QPalette.Highlight,       QColor(T.BRAND_PRIMARY))
    palette.setColor(QPalette.HighlightedText, QColor(T.TEXT_ON_BRAND))
    palette.setColor(QPalette.PlaceholderText, QColor(T.TEXT_TERTIARY))
    app.setPalette(palette)

    qss = _load_stylesheet()
    if qss:
        app.setStyleSheet(qss)

    from ui.main_window import SplashScreen, MainWindow

    splash = SplashScreen()
    splash.show()
    splash.set_progress(10)

    try:
        splash.set_progress(20)
        window = MainWindow(progress_callback=splash.set_progress)
        splash.set_progress(98)
        port = int(os.environ.get("CORTEXAI_API_PORT", 8000))
        _start_api_server(window._ai_core, port)
        splash.set_progress(100)
        splash.finish(window)
        window.show()
        sys.exit(app.exec_())
    except Exception as e:
        splash.close()
        log.critical(f"Fatal startup error: {e}", exc_info=True)
        QMessageBox.critical(
            None, "Fatal Error",
            f"Failed to start CortexAI:\n{e}\n\nSee logs/cortexai.log for details."
        )
        sys.exit(1)


if __name__ == "__main__":
    main()
