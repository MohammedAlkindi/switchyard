import "./main.js";
import { gateFor, parseJSON, parseReports, planMarkdown } from "./report.js";
const $ = (id) => document.getElementById(id);
const esc = (value) => String(value ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c] || c);
const date = (value) => value && Number.isFinite(Date.parse(value))
    ? new Intl.DateTimeFormat(undefined, {
        dateStyle: "medium",
        timeStyle: "short",
    }).format(new Date(value))
    : "Not recorded";
let report;
let synthetic = true;
let selected = new Set();
let exported = false;
let filter = new URL(location.href).searchParams.get("filter") || "all";
let query = "";
let returnFocus;
const dialogs = [
    $("import-dialog"),
    $("evidence-dialog"),
];
function openDialog(id) {
    returnFocus = document.activeElement;
    $(id).showModal();
}
for (const dialog of dialogs)
    dialog.addEventListener("close", () => {
        if (returnFocus?.isConnected)
            returnFocus.focus();
        else
            $("open-import").focus();
        if (dialog.id === "evidence-dialog") {
            const url = new URL(location.href);
            url.searchParams.delete("agent");
            history.replaceState({}, "", url);
        }
    });
function changed() {
    return (!exported &&
        (selected.size > 0 || !!$("handoff-note").value));
}
window.addEventListener("beforeunload", (event) => {
    if (changed()) {
        event.preventDefault();
        event.returnValue = "";
    }
});
function progress() {
    $("plan-count").textContent =
        `${selected.size} agent${selected.size === 1 ? "" : "s"} selected for handoff.`;
    $("download-plan").disabled = !selected.size;
    document
        .querySelectorAll("[data-select]")
        .forEach((input) => (input.checked = selected.has(input.dataset.select || "")));
}
function overlapRows(rows, clean = false) {
    return rows.length
        ? rows
            .map((row) => `<article class="overlap"><div class="item-heading"><code>${esc(row.file)}</code><span class="tag ${clean ? "good" : "warn"}">${clean ? "Committed overlap auto-merges" : row.verdict === "conflicts" ? "Predicted conflict" : row.verdict === "uncommitted" ? "Uncommitted / incomplete evidence" : "Shared file · no simulation"}</span></div><p class="meta">Agents: ${row.agents.map(esc).join(", ")}</p></article>`)
            .join("")
        : '<p class="meta">No shared files recorded for this agent.</p>';
}
function showEvidence(name, restore = true) {
    if (!report)
        return;
    const agent = report.agents.find((agent) => agent.name === name);
    if (!agent)
        return;
    const gate = gateFor(agent, report);
    const collisions = report.check.collisions.filter((row) => row.agents.includes(name));
    const clean = (report.check.cleanMerges || []).filter((row) => row.agents.includes(name));
    $("evidence-body").innerHTML =
        `<p class="eyebrow">02 / Inspect before you integrate</p><h2 id="evidence-title">${esc(agent.name)}</h2><p class="mono">${esc(agent.branch)} → ${esc(agent.baseBranch)}</p><span class="tag ${gate.tone === "hold" ? "warn" : "good"}">${gate.label}</span><div class="gate-reasons"><ul>${gate.reasons.map((reason) => `<li>${esc(reason)}</li>`).join("")}</ul></div><dl class="evidence-facts"><div><dt>Worktree</dt><dd><code>${esc(agent.worktreePath)}</code>${agent.worktreeMissing ? " · missing" : ""}</dd></div><div><dt>Commits vs base</dt><dd>${agent.ahead ?? "?"} ahead · ${agent.behind ?? "?"} behind</dd></div><div><dt>Uncommitted files</dt><dd>${agent.uncommitted}</dd></div><div><dt>Recorded validation</dt><dd>${esc(agent.validation)} · ${esc(date(agent.validatedAt))}</dd></div><div><dt>Last activity</dt><dd>${esc(date(agent.lastActivity))}</dd></div><div><dt>Files touched</dt><dd>${report.check.agentFiles[name]} vs base, including uncommitted work</dd></div></dl><h3>Overlap evidence</h3>${overlapRows(collisions)}${clean.length ? overlapRows(clean, true) : ""}<p class="notice">${report.check.prediction === "merge-tree" ? "Merge-tree simulation compares committed changes. Uncommitted overlaps stay unresolved." : "File-only detection flags shared files. It cannot tell whether committed changes will conflict."} The snapshot can become stale; rerun checks locally.</p><h3>Suggested next checks</h3><p class="meta">Run deliberately in the original repository. This viewer executes nothing.</p>${gate.commands.map((command, index) => `<div class="command-row"><code id="next-command-${index}">${esc(command)}</code><button class="copy" data-copy-target="next-command-${index}">Copy</button></div>`).join("")}<label class="selection"><input type="checkbox" data-select="${esc(name)}" ${selected.has(name) ? "checked" : ""}>Include ${esc(name)} in the review plan</label>`;
    if (synthetic) {
        const url = new URL(location.href);
        url.searchParams.set("agent", name);
        history.replaceState({}, "", url);
    }
    if (restore)
        openDialog("evidence-dialog");
}
function agentRow(agent) {
    if (!report)
        return "";
    const gate = gateFor(agent, report);
    return `<tr><td><input aria-label="Include ${esc(agent.name)} in review plan" type="checkbox" data-select="${esc(agent.name)}" ${selected.has(agent.name) ? "checked" : ""}></td><th scope="row"><button class="agent-link" data-agent="${esc(agent.name)}">${esc(agent.name)} <span aria-hidden="true">↗</span></button><span class="row-sub mono">${esc(agent.branch)}</span></th><td><span class="tag ${gate.tone === "hold" ? "warn" : "good"}">${gate.label}</span></td><td>${agent.worktreeMissing ? '<span class="tag warn">Missing worktree</span>' : agent.uncommitted ? `${agent.uncommitted} uncommitted` : "Clean worktree"}<span class="row-sub">${agent.ahead ?? "?"} ahead / ${agent.behind ?? "?"} behind</span></td><td><span class="tag ${agent.validation === "passed" ? "good" : agent.validation === "failed" ? "bad" : ""}">${esc(agent.validation)}</span></td><td>${report.check.agentFiles[agent.name]}</td></tr>`;
}
function renderRows() {
    if (!report)
        return;
    const rows = report.agents.filter((agent) => (filter === "all" ||
        (filter === "attention"
            ? gateFor(agent, report).tone === "hold"
            : gateFor(agent, report).tone === "review")) &&
        [agent.name, agent.branch]
            .join(" ")
            .toLowerCase()
            .includes(query.toLowerCase()));
    $("agent-rows").innerHTML =
        rows.map(agentRow).join("") ||
            '<tr><td colspan="6" class="empty">No agents match this view. Change the filter or search.</td></tr>';
    $("row-count").textContent =
        `${rows.length} of ${report.agents.length} agents shown`;
}
function render() {
    if (!report)
        return;
    const candidates = report.agents.filter((agent) => gateFor(agent, report).tone === "review").length;
    $("data-notice").textContent = synthetic
        ? "Synthetic example · generated from a real throwaway Git repository. No AI workers or personal repositories are connected."
        : "Imported snapshot · read in this tab only. These reports are not live and may have changed between exports. Refresh both after changes.";
    $("workspace").setAttribute("aria-busy", "false");
    $("workspace").innerHTML =
        `<div class="stats"><div><strong>${report.agents.length}</strong><span>agents in snapshot</span></div><div><strong>${report.check.collisions.length}</strong><span>shared files to coordinate</span></div><div><strong>${report.agents.filter((agent) => agent.validation === "passed").length}</strong><span>validation passes recorded</span></div><div><strong>${candidates}</strong><span>review candidates</span></div></div><div class="list-heading"><div><p class="eyebrow">01 / Find what needs attention</p><h2>Agent worktrees</h2></div><span class="tag">${report.check.prediction === "merge-tree" ? "Merge-tree simulation" : "File-only detection"}</span></div><div class="filter-bar"><label>Show<select id="review-filter"><option value="all">All agents</option><option value="attention">Needs attention</option><option value="review">Review candidates</option></select></label><label>Find an agent<input id="agent-search" name="agent-search" autocomplete="off" type="search" placeholder="Agent or branch…" value="${esc(query)}"></label><p class="meta" id="row-count" role="status"></p></div><div class="table-wrap" role="region" aria-label="Agent worktree snapshot" tabindex="0"><table><caption class="sr-only">Agent worktrees and evidence states. Select an agent name to inspect its recorded evidence.</caption><thead><tr><th scope="col"><span class="sr-only">Plan selection</span></th><th scope="col">Agent / branch</th><th scope="col">Review state</th><th scope="col">Worktree</th><th scope="col">Validation</th><th scope="col">Files</th></tr></thead><tbody id="agent-rows"></tbody></table></div><p class="meta">Select an agent name to inspect evidence. Validation applies to the recorded branch tip and configured command; a clean worktree alone is not validation.</p>`;
    if (!["all", "attention", "review"].includes(filter))
        filter = "all";
    $("review-filter").value = filter;
    $("review-filter").addEventListener("change", (event) => {
        filter = event.target.value;
        const url = new URL(location.href);
        url.searchParams.set("filter", filter);
        history.replaceState({}, "", url);
        renderRows();
    });
    $("agent-search").addEventListener("input", (event) => {
        query = event.target.value;
        renderRows();
    });
    renderRows();
    progress();
}
async function loadExample() {
    if (changed() &&
        !confirm("Replace this review? Download your plan first if you want to keep it."))
        return;
    try {
        const response = await fetch("example.json");
        if (!response.ok)
            throw new Error("Could not load the example. Retry Load example, or open local reports.");
        const data = (await response.json());
        report = parseReports(data.agents, data.check);
        synthetic = true;
        selected = new Set();
        query = "";
        exported = false;
        $("handoff-note").value = "";
        render();
        const name = new URL(location.href).searchParams.get("agent");
        if (name)
            showEvidence(name);
    }
    catch (error) {
        $("data-notice").textContent =
            error instanceof Error
                ? error.message
                : "Could not load example. Retry Load example.";
        $("workspace").setAttribute("aria-busy", "false");
    }
}
$("load-demo").addEventListener("click", () => {
    void loadExample();
});
$("open-import").addEventListener("click", () => openDialog("import-dialog"));
$("handoff-note").addEventListener("input", () => (exported = false));
$("import-form").addEventListener("submit", (event) => {
    event.preventDefault();
    const button = $("import-form").querySelector("[type=submit]");
    const run = async () => {
        button.disabled = true;
        button.textContent = "Reading reports…";
        $("import-error").textContent = "";
        try {
            const agentsFile = $("agents-file").files?.[0];
            const checkFile = $("check-file").files?.[0];
            if (!agentsFile || !checkFile)
                throw new Error("Choose both exported JSON reports.");
            if (agentsFile.size > 1024 * 1024 || checkFile.size > 1024 * 1024)
                throw new Error("Each report must be under 1 MB. Export a smaller fleet.");
            const imported = parseReports(parseJSON(await agentsFile.text()), parseJSON(await checkFile.text()));
            if (changed() &&
                !confirm("Replace this review? Download your plan first if you want to keep it."))
                return;
            report = imported;
            synthetic = false;
            selected = new Set();
            query = "";
            exported = false;
            $("handoff-note").value = "";
            const url = new URL(location.href);
            url.searchParams.delete("agent");
            history.replaceState({}, "", url);
            render();
            $("import-dialog").close();
        }
        catch (error) {
            $("import-error").textContent =
                error instanceof Error
                    ? error.message
                    : "Could not open reports. Export both again.";
            $("agents-file").focus();
        }
        finally {
            button.disabled = false;
            button.textContent = "Inspect reports";
        }
    };
    void run();
});
document.addEventListener("click", (event) => {
    const target = event.target;
    const close = target.closest("[data-close]");
    if (close)
        $(close.dataset.close).close();
    const agent = target.closest("[data-agent]");
    if (agent)
        showEvidence(agent.dataset.agent);
});
document.addEventListener("change", (event) => {
    const input = event.target;
    if (input.dataset.select) {
        if (input.checked)
            selected.add(input.dataset.select);
        else
            selected.delete(input.dataset.select);
        exported = false;
        progress();
    }
});
$("download-plan").addEventListener("click", () => {
    if (!report || !selected.size)
        return;
    const text = planMarkdown(report, [...selected], $("handoff-note").value, synthetic);
    const url = URL.createObjectURL(new Blob([text], { type: "text/markdown;charset=utf-8" }));
    const link = document.createElement("a");
    link.href = url;
    link.download = "switchyard-review-plan.md";
    link.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    exported = true;
    $("download-status").textContent =
        "Plan downloaded. Rerun local checks before integrating any changes.";
});
// Keep imported data and notes out of URLs, browser storage and outbound requests.
void loadExample();
