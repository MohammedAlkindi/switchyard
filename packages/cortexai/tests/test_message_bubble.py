import sys
import os

sys.path.insert(0, os.path.dirname(os.path.dirname(__file__)))

from PyQt5.QtWidgets import QApplication

_app = QApplication.instance() or QApplication([])


def test_append_token_ignored_after_finish_stream():
    from ui.components.message_bubble import AssistantBubble
    bubble = AssistantBubble("test-model")
    bubble.start_stream()
    bubble.append_token("hello ")
    bubble.finish_stream()
    text_before = bubble.get_text()
    bubble.append_token("should be ignored")
    assert bubble.get_text() == text_before


def test_finish_stream_stops_timer():
    from ui.components.message_bubble import AssistantBubble
    bubble = AssistantBubble()
    bubble.start_stream()
    assert bubble._render_timer.isActive()
    bubble.finish_stream()
    assert not bubble._render_timer.isActive()


def test_reset_stops_hide_timer():
    from ui.components.message_bubble import AssistantBubble
    bubble = AssistantBubble()
    bubble.start_stream()
    bubble._hide_timer.start()
    assert bubble._hide_timer.isActive()
    bubble.reset()
    assert not bubble._hide_timer.isActive()
