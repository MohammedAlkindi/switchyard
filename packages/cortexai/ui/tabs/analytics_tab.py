import csv
import logging
from datetime import datetime
from typing import Dict

from PyQt5.QtWidgets import (
    QWidget, QVBoxLayout, QHBoxLayout, QPushButton, QLabel,
    QFileDialog, QMessageBox, QGridLayout, QFrame, QSizePolicy,
    QProgressBar,
)
from PyQt5.QtCore import Qt
from PyQt5.QtGui import QFont, QPainter

try:
    from PyQt5.QtChart import QChart, QChartView, QLineSeries, QValueAxis
    HAS_CHART = True
except ImportError:
    HAS_CHART = False

import ui.theme as T

log = logging.getLogger("CortexAI")


class AnalyticsTab(QWidget):
    def __init__(self, ai_core, parent=None):
        super().__init__(parent)
        self._ai_core = ai_core
        self._conv_store = None
        self._chart_data: Dict = {"cpu": [], "memory": []}
        self._max_points = 60
        self._setup_ui()
        ai_core.performance_metrics.connect(self._on_metrics)

    def set_conversation_store(self, store):
        self._conv_store = store

    def _setup_ui(self):
        self.setStyleSheet(f"background: {T.BG_BASE};")
        layout = QVBoxLayout(self)
        layout.setContentsMargins(0, 0, 0, 0)
        layout.setSpacing(0)

        # Header
        header = QWidget()
        header.setFixedHeight(52)
        header.setAttribute(Qt.WA_StyledBackground, True)
        header.setStyleSheet(
            f"background: {T.BG_SURFACE}; border-bottom: 1px solid {T.BG_BORDER};"
        )
        h_row = QHBoxLayout(header)
        h_row.setContentsMargins(T.SPACING["xl"], 0, T.SPACING["lg"], 0)
        title = QLabel("Analytics")
        title.setFont(QFont(T.FONT_FAMILY, T.FONT_SIZES["md"], T.FONT_WEIGHTS["semibold"]))
        title.setStyleSheet(f"color: {T.TEXT_PRIMARY}; background: transparent;")
        h_row.addWidget(title)
        h_row.addStretch()
        for label, slot in (("Refresh", self._manual_refresh), ("Export CSV", self._export_csv)):
            btn = _hdr_btn(label)
            btn.clicked.connect(slot)
            h_row.addWidget(btn)
        layout.addWidget(header)

        # Scrollable content
        content = QWidget()
        content.setStyleSheet(f"background: {T.BG_BASE};")
        c = QVBoxLayout(content)
        c.setContentsMargins(T.SPACING["xl"], T.SPACING["xl"], T.SPACING["xl"], T.SPACING["xl"])
        c.setSpacing(T.SPACING["xl"])

        # Stat cards row
        c.addWidget(_section_label("AI USAGE"))
        usage_grid = QGridLayout()
        usage_grid.setSpacing(T.SPACING["md"])
        self._usage_cards = {
            "messages":  StatCard("Messages Today",   "—"),
            "tokens":    StatCard("Tokens Used",       "—"),
            "cost":      StatCard("Estimated Cost",    "—",  unit="USD"),
            "latency":   StatCard("Avg Response",      "—",  unit="ms"),
        }
        for i, card in enumerate(self._usage_cards.values()):
            usage_grid.addWidget(card, 0, i)
        c.addLayout(usage_grid)

        # System metrics
        c.addWidget(_section_label("SYSTEM"))
        sys_grid = QGridLayout()
        sys_grid.setSpacing(T.SPACING["md"])
        self._sys_cards = {
            "cpu":     StatCard("CPU",     "—", unit="%"),
            "memory":  StatCard("Memory",  "—", unit="%"),
            "disk":    StatCard("Disk",    "—", unit="%"),
            "threads": StatCard("Threads", "—"),
            "uptime":  StatCard("Uptime",  "—", unit="s"),
            "net":     StatCard("Net I/O", "—"),
        }
        positions = [
            ("cpu", 0, 0), ("memory", 0, 1), ("disk", 0, 2),
            ("threads", 1, 0), ("uptime", 1, 1), ("net", 1, 2),
        ]
        for key, row, col in positions:
            sys_grid.addWidget(self._sys_cards[key], row, col)
        c.addLayout(sys_grid)

        # Metric bars
        c.addWidget(_section_label("REAL-TIME"))
        self._bars: Dict[str, _MetricBar] = {
            "CPU":     _MetricBar("CPU"),
            "RAM":     _MetricBar("RAM"),
            "Disk":    _MetricBar("Disk"),
        }
        for bar in self._bars.values():
            c.addWidget(bar)

        # Chart
        if HAS_CHART:
            self._setup_chart(c)

        c.addStretch()
        layout.addWidget(content, 1)

    def _setup_chart(self, layout):
        from PyQt5.QtCore import QMargins as _QMargins
        self._cpu_series = QLineSeries()
        self._cpu_series.setName("CPU %")
        pen = self._cpu_series.pen()
        pen.setColor(__import__("PyQt5.QtGui", fromlist=["QColor"]).QColor(T.BRAND_PRIMARY))
        pen.setWidth(2)
        self._cpu_series.setPen(pen)

        self._mem_series = QLineSeries()
        self._mem_series.setName("Memory %")

        chart = QChart()
        chart.setTitle("")
        from PyQt5.QtGui import QColor as QC, QBrush
        chart.setBackgroundBrush(QBrush(QC(T.BG_ELEVATED)))
        chart.setPlotAreaBackgroundBrush(QBrush(QC(T.BG_ELEVATED)))
        chart.setPlotAreaBackgroundVisible(True)
        chart.setTheme(QChart.ChartThemeDark)
        chart.addSeries(self._cpu_series)
        chart.addSeries(self._mem_series)
        chart.legend().setLabelColor(QC(T.TEXT_TERTIARY))
        chart.setMargins(_QMargins(8, 8, 8, 8))

        def _axis(title):
            ax = QValueAxis()
            ax.setTitleText(title)
            ax.setTitleBrush(QC(T.TEXT_TERTIARY))
            ax.setLabelsColor(QC(T.TEXT_TERTIARY))
            ax.setGridLineColor(QC(T.BG_BORDER))
            return ax

        self._axis_x = _axis("Seconds")
        self._axis_x.setRange(0, self._max_points)
        self._axis_x.setLabelFormat("%d")
        self._axis_y = _axis("Usage (%)")
        self._axis_y.setRange(0, 100)

        chart.addAxis(self._axis_x, Qt.AlignBottom)
        chart.addAxis(self._axis_y, Qt.AlignLeft)
        for series in (self._cpu_series, self._mem_series):
            series.attachAxis(self._axis_x)
            series.attachAxis(self._axis_y)

        view = QChartView(chart)
        view.setRenderHint(QPainter.Antialiasing)
        view.setMinimumHeight(200)
        view.setStyleSheet(
            f"QChartView {{ border: 1px solid {T.BG_BORDER}; "
            f"border-radius: {T.RADIUS['lg']}px; background: {T.BG_ELEVATED}; }}"
        )
        layout.addWidget(view)

    def _refresh_usage_stats(self):
        if not self._conv_store:
            return
        today = datetime.now().date().isoformat()
        convs = self._conv_store.list_recent(limit=10000)
        msg_count = sum(
            len([m for m in c.get("messages", []) if m["role"] == "user"])
            for c in convs
            if c.get("updated_at", "")[:10] == today
        )
        total_tokens = sum(
            c.get("metadata", {}).get("total_tokens", 0)
            for c in convs
            if c.get("updated_at", "")[:10] == today
        )
        self._usage_cards["messages"].set_value(str(msg_count))
        self._usage_cards["tokens"].set_value(f"{total_tokens:,}")
        self._usage_cards["cost"].set_value(f"${total_tokens * 0.000003:.4f}")

    def _on_metrics(self, metrics: Dict):
        self._refresh_usage_stats()
        self._sys_cards["cpu"].set_value(str(metrics.get("cpu", "—")))
        self._sys_cards["memory"].set_value(str(metrics.get("memory", "—")))
        self._sys_cards["disk"].set_value(str(metrics.get("disk", "—")))
        self._sys_cards["threads"].set_value(str(metrics.get("threads", "—")))
        self._sys_cards["uptime"].set_value(str(int(metrics.get("uptime_s", 0))))
        sent = metrics.get("net_sent_mb", "—")
        recv = metrics.get("net_recv_mb", "—")
        self._sys_cards["net"].set_value(f"{sent}↑ {recv}↓")

        # Metric bars
        cpu = metrics.get("cpu", 0)
        mem = metrics.get("memory", 0)
        disk = metrics.get("disk", 0)
        self._bars["CPU"].set_value(int(cpu))
        self._bars["RAM"].set_value(int(mem))
        self._bars["Disk"].set_value(int(disk))

        if HAS_CHART:
            self._chart_data["cpu"].append(cpu)
            self._chart_data["memory"].append(metrics.get("memory", 0))
            if len(self._chart_data["cpu"]) > self._max_points:
                self._chart_data["cpu"].pop(0)
                self._chart_data["memory"].pop(0)
            self._cpu_series.clear()
            self._mem_series.clear()
            for i, (c, m) in enumerate(zip(self._chart_data["cpu"], self._chart_data["memory"])):
                self._cpu_series.append(i, c)
                self._mem_series.append(i, m)

    def _manual_refresh(self):
        self._ai_core._collect_metrics()

    def _export_csv(self):
        path, _ = QFileDialog.getSaveFileName(self, "Export Metrics", "", "CSV Files (*.csv)")
        if not path:
            return
        try:
            with open(path, "w", newline="", encoding="utf-8") as f:
                writer = csv.writer(f)
                writer.writerow(["Index", "CPU (%)", "Memory (%)"])
                for i, (c, m) in enumerate(zip(self._chart_data["cpu"], self._chart_data["memory"])):
                    writer.writerow([i, c, m])
            QMessageBox.information(self, "Exported", f"Saved to {path}")
        except Exception as e:
            QMessageBox.critical(self, "Export Failed", str(e))

    def reset(self):
        pass


class StatCard(QFrame):
    def __init__(self, title: str, value: str = "—", unit: str = "", parent=None):
        super().__init__(parent)
        self._unit = unit
        self.setStyleSheet(
            f"QFrame {{ background: {T.BG_ELEVATED}; border: 1px solid {T.BG_BORDER}; "
            f"border-radius: {T.RADIUS['lg']}px; }}"
            f"QLabel {{ border: none; background: transparent; }}"
        )
        self.setMinimumHeight(90)

        v = QVBoxLayout(self)
        v.setContentsMargins(T.SPACING["lg"], T.SPACING["md"], T.SPACING["lg"], T.SPACING["md"])
        v.setSpacing(T.SPACING["xs"])

        self._title = QLabel(title.upper())
        self._title.setFont(QFont(T.FONT_FAMILY, T.FONT_SIZES["xs"]))
        self._title.setStyleSheet(
            f"color: {T.TEXT_TERTIARY}; letter-spacing: 0.08em;"
        )
        v.addWidget(self._title)

        row = QHBoxLayout()
        row.setSpacing(T.SPACING["xs"])
        self._value = QLabel(value)
        self._value.setFont(QFont(T.FONT_FAMILY, T.FONT_SIZES["2xl"], T.FONT_WEIGHTS["semibold"]))
        self._value.setStyleSheet(f"color: {T.TEXT_PRIMARY};")
        row.addWidget(self._value)
        if unit:
            u = QLabel(unit)
            u.setFont(QFont(T.FONT_FAMILY, T.FONT_SIZES["sm"]))
            u.setStyleSheet(f"color: {T.TEXT_TERTIARY}; padding-top: 8px;")
            row.addWidget(u)
        row.addStretch()
        v.addLayout(row)

    def set_value(self, v: str):
        self._value.setText(v)


class _MetricBar(QWidget):
    def __init__(self, label: str, parent=None):
        super().__init__(parent)
        self.setAttribute(Qt.WA_StyledBackground, True)
        self.setStyleSheet("background: transparent;")
        self._value = 0

        v = QVBoxLayout(self)
        v.setContentsMargins(0, 0, 0, 0)
        v.setSpacing(T.SPACING["xs"])

        row = QHBoxLayout()
        lbl = QLabel(label)
        lbl.setFont(QFont(T.FONT_FAMILY, T.FONT_SIZES["sm"]))
        lbl.setStyleSheet(f"color: {T.TEXT_SECONDARY}; background: transparent;")
        row.addWidget(lbl)
        row.addStretch()
        self._pct = QLabel("—%")
        self._pct.setFont(QFont(T.FONT_FAMILY, T.FONT_SIZES["sm"]))
        self._pct.setStyleSheet(f"color: {T.TEXT_TERTIARY}; background: transparent;")
        row.addWidget(self._pct)
        v.addLayout(row)

        self._bar = QProgressBar()
        self._bar.setFixedHeight(4)
        self._bar.setRange(0, 100)
        self._bar.setValue(0)
        self._bar.setTextVisible(False)
        self._bar.setStyleSheet(
            f"QProgressBar {{ background: {T.BG_BORDER}; border: none; border-radius: 2px; }}"
            f"QProgressBar::chunk {{ background: {T.SUCCESS}; border-radius: 2px; }}"
        )
        v.addWidget(self._bar)

    def set_value(self, pct: int):
        self._value = pct
        self._pct.setText(f"{pct}%")
        self._bar.setValue(pct)
        if pct >= 85:
            color = T.ERROR
        elif pct >= 60:
            color = T.WARNING
        else:
            color = T.SUCCESS
        self._bar.setStyleSheet(
            f"QProgressBar {{ background: {T.BG_BORDER}; border: none; border-radius: 2px; }}"
            f"QProgressBar::chunk {{ background: {color}; border-radius: 2px; }}"
        )


def _section_label(text: str) -> QLabel:
    lbl = QLabel(text)
    lbl.setFont(QFont(T.FONT_FAMILY, T.FONT_SIZES["xs"]))
    lbl.setStyleSheet(
        f"color: {T.TEXT_TERTIARY}; letter-spacing: 0.08em; background: transparent;"
    )
    return lbl


def _hdr_btn(text: str) -> QPushButton:
    btn = QPushButton(text)
    btn.setFixedHeight(28)
    btn.setFont(QFont(T.FONT_FAMILY, T.FONT_SIZES["sm"]))
    btn.setStyleSheet(
        f"QPushButton {{ background: transparent; color: {T.TEXT_TERTIARY}; "
        f"  border: 1px solid {T.BG_BORDER}; border-radius: {T.RADIUS['md']}px; padding: 0 12px; }}"
        f"QPushButton:hover {{ color: {T.TEXT_PRIMARY}; border-color: {T.BG_OVERLAY}; }}"
    )
    return btn
