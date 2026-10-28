export interface Agent {
  name: string;
  branch: string;
  baseBranch: string;
  worktreePath: string;
  worktreeMissing: boolean;
  ahead: number | null;
  behind: number | null;
  uncommitted: number;
  lastActivity: string | null;
  validation: "passed" | "failed" | "stale" | "none";
  validatedAt: string | null;
}
export interface Overlap {
  file: string;
  agents: string[];
  verdict?: "conflicts" | "uncommitted";
}
export interface Report {
  agents: Agent[];
  check: {
    collisions: Overlap[];
    cleanMerges?: Overlap[];
    prediction: "merge-tree" | "files";
    agentsChecked: number;
    agentFiles: Record<string, number>;
  };
}
export interface Gate {
  label: string;
  tone: "hold" | "review";
  reasons: string[];
  commands: string[];
}
const obj = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === "object" && !Array.isArray(value);
const text = (value: unknown): value is string =>
  typeof value === "string" && value.length <= 2048;
const count = (value: unknown): value is number =>
  Number.isSafeInteger(value) && Number(value) >= 0;
const nullableCount = (value: unknown) => value === null || count(value);
const nullableText = (value: unknown) => value === null || text(value);
const validName = (value: unknown): value is string =>
  typeof value === "string" && /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,63}$/.test(value);

/** Accept only the existing fleet list/check JSON contracts. Never evaluate input. */
export function parseReports(list: unknown, check: unknown): Report {
  const invalid = () => {
    throw new Error(
      "Reports do not match the fleet list/check JSON format. Export both again from the same repository.",
    );
  };
  if (!Array.isArray(list) || list.length > 100 || !obj(check))
    return invalid();
  const names = new Set<string>();
  for (const row of list) {
    if (
      !obj(row) ||
      !validName(row.name) ||
      names.has(row.name) ||
      !text(row.branch) ||
      !text(row.baseBranch) ||
      !text(row.worktreePath) ||
      typeof row.worktreeMissing !== "boolean" ||
      !nullableCount(row.ahead) ||
      !nullableCount(row.behind) ||
      !count(row.uncommitted) ||
      !nullableText(row.lastActivity) ||
      !nullableText(row.validatedAt) ||
      !["passed", "failed", "stale", "none"].includes(String(row.validation))
    )
      return invalid();
    names.add(row.name);
  }
  if (
    !["merge-tree", "files"].includes(String(check.prediction)) ||
    check.agentsChecked !== names.size ||
    !obj(check.agentFiles) ||
    Object.keys(check.agentFiles).length !== names.size ||
    ![...names].every(
      (name) =>
        Object.hasOwn(check.agentFiles as object, name) &&
        count((check.agentFiles as Record<string, unknown>)[name]),
    )
  )
    return invalid();
  function overlaps(value: unknown): boolean {
    return (
      Array.isArray(value) &&
      value.length <= 1000 &&
      value.every(
        (row) =>
          obj(row) &&
          text(row.file) &&
          Array.isArray(row.agents) &&
          row.agents.length >= 2 &&
          row.agents.length <= names.size &&
          new Set(row.agents).size === row.agents.length &&
          row.agents.every(
            (name) => typeof name === "string" && names.has(name),
          ) &&
          (row.verdict === undefined ||
            row.verdict === "conflicts" ||
            row.verdict === "uncommitted"),
      )
    );
  }
  if (
    !overlaps(check.collisions) ||
    (check.cleanMerges !== undefined && !overlaps(check.cleanMerges))
  )
    return invalid();
  if (
    check.prediction === "files" &&
    ((check.collisions as Overlap[]).some((row) => row.verdict !== undefined) ||
      ((check.cleanMerges as Overlap[] | undefined)?.length ?? 0) > 0)
  )
    return invalid();
  return {
    agents: list as Agent[],
    check: check as unknown as Report["check"],
  };
}
export function parseJSON(value: string): unknown {
  if (value.length > 1024 * 1024)
    throw new Error("Each report must be under 1 MB. Export a smaller fleet.");
  try {
    return JSON.parse(value.replace(/^\uFEFF/, "")) as unknown;
  } catch {
    throw new Error(
      "Could not read JSON. Choose the original agents.json and collisions.json exports.",
    );
  }
}
export function gateFor(agent: Agent, report: Report): Gate {
  const reasons: string[] = [];
  const commands = [`fleet status ${agent.name}`, `fleet diff ${agent.name}`];
  if (agent.worktreeMissing || agent.ahead === null || agent.behind === null)
    reasons.push(
      "Worktree or branch evidence is missing. Inspect fleet doctor before proceeding.",
    );
  const overlaps = report.check.collisions.filter((row) =>
    row.agents.includes(agent.name),
  );
  if (overlaps.length)
    reasons.push(
      `${overlaps.length} shared file${overlaps.length === 1 ? " needs" : "s need"} coordination. Inspect the overlap evidence below.`,
    );
  if (agent.uncommitted)
    reasons.push(
      `${agent.uncommitted} uncommitted file${agent.uncommitted === 1 ? "" : "s"}. Review and commit intended work in this agent’s worktree before validating.`,
    );
  if ((agent.behind ?? 0) > 0)
    reasons.push(
      "The base has moved. Coordinate a fleet sync, inspect the result, then validate again.",
    );
  if (agent.validation !== "passed")
    reasons.push(
      {
        failed:
          "Recorded validation failed. Fix the failure, then validate again.",
        stale:
          "Validation is stale: the branch tip or validation command changed. Validate the current work.",
        none: "No current validation is recorded. Configure a validate command in .fleetrc.json, then validate.",
      }[agent.validation],
    );
  if (agent.ahead === 0)
    reasons.push(
      "No commits ahead of the recorded base. There may be no changes to land.",
    );
  if (report.check.prediction === "files")
    reasons.push(
      "File-only detection: shared files are not a simulated merge verdict. Use Git 2.38+ for merge simulation.",
    );
  if (agent.worktreeMissing || agent.ahead === null)
    commands.push("fleet doctor");
  if (
    !agent.worktreeMissing &&
    !agent.uncommitted &&
    agent.validation !== "passed"
  )
    commands.push(`fleet validate ${agent.name}`);
  commands.push("fleet check");
  return {
    label: reasons.length ? "Needs attention" : "Review candidate",
    tone: reasons.length ? "hold" : "review",
    reasons: reasons.length
      ? reasons
      : [
          "No recorded blockers in this snapshot. Inspect the diff and rerun checks locally before any merge.",
        ],
    commands,
  };
}
export function planMarkdown(
  report: Report,
  selected: string[],
  note: string,
  synthetic: boolean,
): string {
  return (
    [
      "# Switchyard review plan",
      synthetic
        ? "Synthetic demonstration. No repository is connected."
        : "Imported local snapshot. This is not a live merge approval.",
      "Re-export after changes. Commands below are suggestions to run deliberately in the original repository; this page executes nothing.",
      ...report.agents
        .filter((agent) => selected.includes(agent.name))
        .map((agent) => {
          const gate = gateFor(agent, report);
          return [
            `## ${agent.name} — ${gate.label}`,
            `Branch: ${agent.branch}; base: ${agent.baseBranch}`,
            `Validation: ${agent.validation}; uncommitted: ${agent.uncommitted}`,
            ...gate.reasons.map((reason) => `- ${reason}`),
            "Suggested commands:",
            "```sh",
            ...gate.commands,
            "```",
          ].join("\n");
        }),
      "## Your handoff note (not source evidence)",
      note || "No note recorded.",
    ].join("\n\n") + "\n"
  );
}
