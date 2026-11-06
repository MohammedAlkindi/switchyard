import sys
import os

sys.path.insert(0, os.path.dirname(os.path.dirname(__file__)))

from PyQt5.QtWidgets import QApplication

_app = QApplication.instance() or QApplication([])


def test_search_bar_emits_search_changed():
    from ui.components.search_bar import ConvSearchBar
    bar = ConvSearchBar()
    signals = []
    bar.search_changed.connect(signals.append)
    bar._input.setText("hello")
    assert "hello" in signals


def test_search_bar_set_results_no_results():
    from ui.components.search_bar import ConvSearchBar
    bar = ConvSearchBar()
    bar.set_results(0)
    assert bar._count.text() == "No results"


def test_search_bar_set_results_with_results():
    from ui.components.search_bar import ConvSearchBar
    bar = ConvSearchBar()
    bar.set_results(5, 2)
    assert "3" in bar._count.text()  # current + 1 = 3/5


def test_search_bar_closed_signal():
    from ui.components.search_bar import ConvSearchBar
    bar = ConvSearchBar()
    signals = []
    bar.closed.connect(lambda: signals.append(True))
    bar.closed.emit()
    assert signals == [True]
