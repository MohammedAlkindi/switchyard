import logging
import os
import sys
import time
from pathlib import Path

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
    fh = logging.FileHandler("cortexai.log", encoding="utf-8")
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
    log = setup_logging()

    # Keep physical pixel sizes matching design specs on scaled Windows displays
    os.environ.setdefault("QT_SCALE_FACTOR", "1")

    QApplication.setAttribute(Qt.AA_UseHighDpiPixmaps)

    app = QApplication(sys.argv)
    app.setApplicationName("CortexAI")
    app.setApplicationVersion("1.0")
    app.setStyle("Fusion")

    # Initialise font family (must happen after QApplication creation)
    T.init_fonts()

    # Apply global palette matching design system
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

    # Apply global QSS stylesheet
    qss = _load_stylesheet()
    if qss:
        app.setStyleSheet(qss)

    from ui.main_window import SplashScreen, MainWindow

    splash = SplashScreen()
    splash.show()

    for i in range(0, 101, 20):
        splash.set_progress(i)
        time.sleep(0.04)

    try:
        window = MainWindow()
        splash.finish(window)
        window.show()
        sys.exit(app.exec_())
    except Exception as e:
        splash.close()
        log.critical(f"Fatal startup error: {e}", exc_info=True)
        QMessageBox.critical(
            None, "Fatal Error",
            f"Failed to start CortexAI:\n{e}\n\nSee cortexai.log for details."
        )
        sys.exit(1)


if __name__ == "__main__":
    main()
