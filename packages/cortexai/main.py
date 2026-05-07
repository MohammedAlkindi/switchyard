import logging
import os
import sys
import time

try:
    from dotenv import load_dotenv
    load_dotenv()
except ImportError:
    pass  # python-dotenv not installed; rely on shell environment

from PyQt5.QtWidgets import QApplication, QMessageBox
from PyQt5.QtGui import QColor, QPalette
from PyQt5.QtCore import Qt

from ui.main_window import MainWindow, SplashScreen


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
    fh = logging.FileHandler("cortexai.log", encoding="utf-8")
    fh.setLevel(logging.DEBUG)
    fh.setFormatter(fmt)
    logger.addHandler(ch)
    logger.addHandler(fh)
    return logger


def main():
    log = setup_logging()

    QApplication.setAttribute(Qt.AA_EnableHighDpiScaling)
    QApplication.setAttribute(Qt.AA_UseHighDpiPixmaps)

    app = QApplication(sys.argv)
    app.setApplicationName("CortexAI")
    app.setApplicationVersion("1.0")
    app.setStyle("Fusion")

    palette = QPalette()
    palette.setColor(QPalette.Window, QColor("#1e1e1e"))
    palette.setColor(QPalette.WindowText, QColor("#d4d4d4"))
    palette.setColor(QPalette.Base, QColor("#252526"))
    palette.setColor(QPalette.AlternateBase, QColor("#2d2d2d"))
    palette.setColor(QPalette.Text, QColor("#d4d4d4"))
    palette.setColor(QPalette.Button, QColor("#2d2d2d"))
    palette.setColor(QPalette.ButtonText, QColor("#d4d4d4"))
    palette.setColor(QPalette.Highlight, QColor("#0e639c"))
    palette.setColor(QPalette.HighlightedText, QColor("#ffffff"))
    app.setPalette(palette)

    splash = SplashScreen()
    splash.show()

    for i in range(0, 101, 20):
        splash.set_progress(i)
        time.sleep(0.05)

    try:
        window = MainWindow()
        splash.finish(window)
        window.show()
        sys.exit(app.exec_())
    except Exception as e:
        splash.close()
        log.critical(f"Fatal startup error: {e}", exc_info=True)
        QMessageBox.critical(None, "Fatal Error", f"Failed to start:\n{e}\n\nSee cortexai.log for details.")
        sys.exit(1)


if __name__ == "__main__":
    main()
