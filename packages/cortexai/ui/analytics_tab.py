import csv
import logging
from typing import Dict

from PyQt5.QtWidgets import (
    QWidget, QVBoxLayout, QHBoxLayout, QPushButton, QLabel,
    QTextEdit, QFileDialog, QMessageBox,
)
from PyQt5.QtGui import QFont, QColor, QPainter, QSyntaxHighlighter, QTextCharFormat
from PyQt5.QtCore import Qt, QRegularExpression

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
        keywords = [
            "def", "class", "import", "from", "return", "if", "else", "elif",
            "for", "while", "try", "except", "with", "as", "pass", "break",
            "continue", "True", "False", "None", "and", "or", "not", "in",
            "is", "lambda", "yield", "async", "await",
        ]
        for kw in keywords:
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
            match_iter = pattern.globalMatch(text)
            while match_iter.hasNext():
                match = match_iter.next()
                self.setFormat(match.capturedStart(), match.capturedLength(), fmt)


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

        self._metrics_display = QTextEdit()
        self._metrics_display.setReadOnly(True)
        self._metrics_display.setFont(QFont("Consolas", 11))
        self._metrics_display.setStyleSheet(
            "background:#1e1e1e; color:#d4d4d4; border:1px solid #444; border-radius:4px;"
        )
        layout.addWidget(QLabel("System Metrics"))
        layout.addWidget(self._metrics_display)

        if HAS_CHART:
            self._setup_chart(layout)

        btn_row = QHBoxLayout()
        refresh_btn = QPushButton("Refresh")
        refresh_btn.clicked.connect(self._manual_refresh)
        export_btn = QPushButton("Export CSV")
        export_btn.clicked.connect(self._export_csv)
        btn_row.addWidget(refresh_btn)
        btn_row.addWidget(export_btn)
        btn_row.addStretch()
        layout.addLayout(btn_row)

    def _setup_chart(self, layout):
        self._cpu_series = QLineSeries()
        self._cpu_series.setName("CPU %")
        self._mem_series = QLineSeries()
        self._mem_series.setName("Memory %")

        chart = QChart()
        chart.setTitle("Real-Time System Performance")
        chart.setTheme(QChart.ChartThemeDark)
        chart.addSeries(self._cpu_series)
        chart.addSeries(self._mem_series)

        self._axis_x = QValueAxis()
        self._axis_x.setRange(0, self._max_points)
        self._axis_x.setLabelFormat("%d")
        self._axis_x.setTitleText("Seconds")

        self._axis_y = QValueAxis()
        self._axis_y.setRange(0, 100)
        self._axis_y.setTitleText("Usage (%)")

        chart.addAxis(self._axis_x, Qt.AlignBottom)
        chart.addAxis(self._axis_y, Qt.AlignLeft)
        self._cpu_series.attachAxis(self._axis_x)
        self._cpu_series.attachAxis(self._axis_y)
        self._mem_series.attachAxis(self._axis_x)
        self._mem_series.attachAxis(self._axis_y)

        chart_view = QChartView(chart)
        chart_view.setRenderHint(QPainter.Antialiasing)
        chart_view.setMinimumHeight(200)
        layout.addWidget(chart_view)

    def _on_metrics(self, metrics: Dict):
        lines = [
            f"CPU:        {metrics.get('cpu', 'N/A')}%",
            f"Memory:     {metrics.get('memory', 'N/A')}%",
            f"Disk:       {metrics.get('disk', 'N/A')}%",
            f"Threads:    {metrics.get('threads', 'N/A')}",
            f"Uptime:     {int(metrics.get('uptime_s', 0))}s",
            f"Net Sent:   {metrics.get('net_sent_mb', 'N/A')} MB",
            f"Net Recv:   {metrics.get('net_recv_mb', 'N/A')} MB",
        ]
        if "gpu" in metrics and metrics["gpu"] is not None:
            lines.append(f"GPU Mem:    {metrics['gpu']:.1f}%")
        self._metrics_display.setText("\n".join(lines))

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
