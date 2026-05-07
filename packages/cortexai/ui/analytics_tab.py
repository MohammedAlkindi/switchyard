import csv
import logging
from typing import Dict

from PyQt5.QtWidgets import (
    QWidget, QVBoxLayout, QHBoxLayout, QPushButton, QLabel,
    QFileDialog, QMessageBox, QGridLayout, QFrame,
)
from PyQt5.QtGui import QFont, QColor, QPainter, QSyntaxHighlighter, QTextCharFormat
from PyQt5.QtCore import Qt, QRegularExpression, QMargins

try:
    from PyQt5.QtChart import QChart, QChartView, QLineSeries, QValueAxis
    HAS_CHART = True
except ImportError:
    HAS_CHART = False

log = logging.getLogger("CortexAI")


class CodeHighlighter(QSyntaxHighlighter):
    def __init__(self, parent=None):
        super().__init__(parent)
        self._rules = []

        keyword_fmt = QTextCharFormat()
        keyword_fmt.setForeground(QColor("#569CD6"))
        keyword_fmt.setFontWeight(QFont.Bold)
        for kw in [
            "def", "class", "import", "from", "return", "if", "else", "elif",
            "for", "while", "try", "except", "with", "as", "pass", "break",
            "continue", "True", "False", "None", "and", "or", "not", "in",
            "is", "lambda", "yield", "async", "await",
        ]:
            self._rules.append((QRegularExpression(rf"\b{kw}\b"), keyword_fmt))

        string_fmt = QTextCharFormat()
        string_fmt.setForeground(QColor("#CE9178"))
        self._rules.append((QRegularExpression(r'"[^"\\]*(\\.[^"\\]*)*"'), string_fmt))
        self._rules.append((QRegularExpression(r"'[^'\\]*(\\.[^'\\]*)*'"), string_fmt))

        comment_fmt = QTextCharFormat()
        comment_fmt.setForeground(QColor("#6A9955"))
        self._rules.append((QRegularExpression(r"#[^\n]*"), comment_fmt))

        number_fmt = QTextCharFormat()
        number_fmt.setForeground(QColor("#B5CEA8"))
        self._rules.append((QRegularExpression(r"\b\d+(\.\d+)?\b"), number_fmt))

    def highlightBlock(self, text: str):
        for pattern, fmt in self._rules:
            it = pattern.globalMatch(text)
            while it.hasNext():
                m = it.next()
                self.setFormat(m.capturedStart(), m.capturedLength(), fmt)


class MetricCard(QFrame):
    def __init__(self, title: str, value: str = "—", unit: str = "", parent=None):
        super().__init__(parent)
        self._unit = unit
        self.setFrameShape(QFrame.NoFrame)
        self.setStyleSheet(
            "QFrame { background:#161616; border:1px solid #1E1E1E; border-radius:8px; }"
            "QLabel { border:none; background:transparent; }"
        )
        self.setMinimumHeight(80)

        layout = QVBoxLayout(self)
        layout.setContentsMargins(16, 14, 16, 14)
        layout.setSpacing(4)

        self._title_lbl = QLabel(title.upper())
        self._title_lbl.setStyleSheet(
            "color:#404040; font-size:10px; font-weight:700; letter-spacing:0.8px;"
        )

        val_row = QHBoxLayout()
        val_row.setSpacing(4)

        self._value_lbl = QLabel(value)
        self._value_lbl.setStyleSheet(
            "color:#E2E2E2; font-size:22px; font-weight:600; letter-spacing:-0.5px;"
        )
        val_row.addWidget(self._value_lbl)

        if unit:
            unit_lbl = QLabel(unit)
            unit_lbl.setStyleSheet("color:#444; font-size:12px; padding-top:6px;")
            val_row.addWidget(unit_lbl)
        val_row.addStretch()

        layout.addWidget(self._title_lbl)
        layout.addLayout(val_row)

    def set_value(self, value: str):
        self._value_lbl.setText(value)


class AnalyticsTab(QWidget):
    def __init__(self, ai_core, parent=None):
        super().__init__(parent)
        self._ai_core = ai_core
        self._chart_data: Dict = {"cpu": [], "memory": []}
        self._max_points = 60
        self._setup_ui()
        ai_core.performance_metrics.connect(self._on_metrics)

    def _setup_ui(self):
        layout = QVBoxLayout(self)
        layout.setContentsMargins(0, 0, 0, 0)
        layout.setSpacing(0)

        # ── Header ────────────────────────────────────────────────────────
        header = QWidget()
        header.setFixedHeight(48)
        header.setAttribute(Qt.WA_StyledBackground, True)
        header.setStyleSheet("background:#0F0F0F; border-bottom:1px solid #1C1C1C;")
        h_row = QHBoxLayout(header)
        h_row.setContentsMargins(22, 0, 16, 0)
        h_row.setSpacing(8)

        title = QLabel("Analytics")
        title.setStyleSheet("color:#E2E2E2; font-size:14px; font-weight:600; background:transparent;")
        h_row.addWidget(title)
        h_row.addStretch()

        _btn_style = (
            "QPushButton { background:transparent; color:#555; border:1px solid #252525; "
            "    border-radius:5px; padding:0 12px; font-size:12px; }"
            "QPushButton:hover { background:#1A1A1A; color:#CCC; border-color:#333; }"
        )
        refresh_btn = QPushButton("Refresh")
        refresh_btn.setFixedHeight(28)
        refresh_btn.setStyleSheet(_btn_style)
        refresh_btn.clicked.connect(self._manual_refresh)

        export_btn = QPushButton("Export CSV")
        export_btn.setFixedHeight(28)
        export_btn.setStyleSheet(_btn_style)
        export_btn.clicked.connect(self._export_csv)

        h_row.addWidget(refresh_btn)
        h_row.addWidget(export_btn)
        h_row.addSpacing(6)
        layout.addWidget(header)

        # ── Content ───────────────────────────────────────────────────────
        content = QWidget()
        content.setAttribute(Qt.WA_StyledBackground, True)
        content.setStyleSheet("background:#0B0B0B;")
        c_layout = QVBoxLayout(content)
        c_layout.setContentsMargins(20, 20, 20, 20)
        c_layout.setSpacing(16)

        section_lbl = QLabel("SYSTEM")
        section_lbl.setStyleSheet(
            "color:#303030; font-size:10px; font-weight:700; letter-spacing:0.9px;"
        )
        c_layout.addWidget(section_lbl)

        grid = QGridLayout()
        grid.setSpacing(10)

        self._cards = {
            "cpu":     MetricCard("CPU",     "—", "%"),
            "memory":  MetricCard("Memory",  "—", "%"),
            "disk":    MetricCard("Disk",    "—", "%"),
            "threads": MetricCard("Threads", "—"),
            "uptime":  MetricCard("Uptime",  "—", "s"),
            "net":     MetricCard("Net I/O", "—"),
        }
        positions = [
            ("cpu", 0, 0), ("memory", 0, 1), ("disk",    0, 2),
            ("threads", 1, 0), ("uptime", 1, 1), ("net", 1, 2),
        ]
        for key, row, col in positions:
            grid.addWidget(self._cards[key], row, col)

        c_layout.addLayout(grid)

        if HAS_CHART:
            self._setup_chart(c_layout)

        layout.addWidget(content, 1)

    def _setup_chart(self, layout):
        self._cpu_series = QLineSeries()
        self._cpu_series.setName("CPU %")
        self._mem_series = QLineSeries()
        self._mem_series.setName("Memory %")

        chart = QChart()
        chart.setTitle("")
        chart.setBackgroundBrush(QColor("#161616"))
        chart.setPlotAreaBackgroundBrush(QColor("#161616"))
        chart.setPlotAreaBackgroundVisible(True)
        chart.setTheme(QChart.ChartThemeDark)
        chart.addSeries(self._cpu_series)
        chart.addSeries(self._mem_series)
        chart.legend().setLabelColor(QColor("#555"))
        chart.setMargins(QMargins(8, 8, 8, 8))

        def _axis(title: str) -> QValueAxis:
            ax = QValueAxis()
            ax.setTitleText(title)
            ax.setTitleBrush(QColor("#444"))
            ax.setLabelsColor(QColor("#444"))
            ax.setGridLineColor(QColor("#1C1C1C"))
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

        chart_view = QChartView(chart)
        chart_view.setRenderHint(QPainter.Antialiasing)
        chart_view.setMinimumHeight(180)
        chart_view.setStyleSheet(
            "QChartView { border:1px solid #1E1E1E; border-radius:8px; background:#161616; }"
        )
        layout.addWidget(chart_view)

    # ── Data ──────────────────────────────────────────────────────────────

    def _on_metrics(self, metrics: Dict):
        self._cards["cpu"].set_value(str(metrics.get("cpu", "—")))
        self._cards["memory"].set_value(str(metrics.get("memory", "—")))
        self._cards["disk"].set_value(str(metrics.get("disk", "—")))
        self._cards["threads"].set_value(str(metrics.get("threads", "—")))
        self._cards["uptime"].set_value(str(int(metrics.get("uptime_s", 0))))

        sent = metrics.get("net_sent_mb", "—")
        recv = metrics.get("net_recv_mb", "—")
        self._cards["net"].set_value(f"{sent}↑  {recv}↓")

        if HAS_CHART:
            self._chart_data["cpu"].append(metrics.get("cpu", 0))
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
            QMessageBox.information(self, "Exported", f"Metrics saved to {path}")
        except Exception as e:
            QMessageBox.critical(self, "Export Failed", str(e))
