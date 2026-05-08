import sys
import os

sys.path.insert(0, os.path.dirname(os.path.dirname(__file__)))

from PyQt5.QtWidgets import QApplication


def _app():
    return QApplication.instance() or QApplication([])


def test_input_bar_send_signal():
    _app()
    from ui.components.input_bar import InputBar
    bar = InputBar()
    signals = []
    bar.send_requested.connect(signals.append)
    bar._input.setPlainText("hello")
    bar._on_send()
    assert signals == ["hello"]
    assert bar._input.toPlainText() == ""


def test_input_bar_clears_on_send():
    _app()
    from ui.components.input_bar import InputBar
    bar = InputBar()
    bar._input.setPlainText("test message")
    signals = []
    bar.send_requested.connect(signals.append)
    bar._on_send()
    assert bar._input.toPlainText() == ""
    assert len(signals) == 1


def test_input_bar_empty_send_ignored():
    _app()
    from ui.components.input_bar import InputBar
    bar = InputBar()
    signals = []
    bar.send_requested.connect(signals.append)
    bar._input.setPlainText("   ")
    bar._on_send()
    assert signals == []


def test_input_bar_stop_mode():
    _app()
    from ui.components.input_bar import InputBar
    bar = InputBar()
    bar.set_streaming(True)
    assert bar._send_btn._stop_mode is True
    bar.set_streaming(False)
    assert bar._send_btn._stop_mode is False
