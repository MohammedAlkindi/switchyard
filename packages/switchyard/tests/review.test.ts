import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { beforeAll, describe, expect, it, vi } from "vitest";
import { collectDashboard } from "../src/commands/dashboard.js";
import { spawn } from "../src/commands/spawn.js";
import {
  parseJSON,
  parseReports,
  gateFor,
  planMarkdown,
} from "../public/report.js";
import type { Report } from "../public/report.js";
import { makeTempRepo, worktreePath } from "./helpers.js";
import { makeReviewFixture } from "./review-fixture.js";
let report: Report;
beforeAll(async () => {
  const log = vi.spyOn(console, "log").mockImplementation(() => {});
  try {
    const data = await makeReviewFixture();
    report = parseReports(data.agents, data.check);
  } finally {
    log.mockRestore();
  }
}, 30000);
describe("browser review uses actual fleet evidence", () => {
  it("holds real committed conflicts even when one agent passed validation", () => {
    const api = report.agents.find((a) => a.name === "api")!;
    expect(api.validation).toBe("passed");
    expect(report.check.collisions).toEqual([
      expect.objectContaining({ file: "src.txt", agents: ["api", "auth"] }),
    ]);
    expect(gateFor(api, report).tone).toBe("hold");
    expect(gateFor(api, report).reasons.join(" ")).toContain("coordination");
  });
  it("keeps validation stale after a new real commit and offers revalidation", () => {
    const auth = report.agents.find((a) => a.name === "auth")!;
    expect(auth.validation).toBe("stale");
    expect(gateFor(auth, report).commands).toContain("fleet validate auth");
  });
  it("treats a clean, validated, nonoverlapping worktree as a review candidate, never an automatic merge", () => {
    const docs = report.agents.find((a) => a.name === "docs")!;
    expect(gateFor(docs, report).label).toBe("Review candidate");
    expect(gateFor(docs, report).commands).not.toContain("fleet merge docs");
    const plan = planMarkdown(report, ["docs"], "Inspect the guide.", true);
    expect(plan).toContain("Synthetic demonstration");
    expect(plan).toContain("Inspect the guide.");
    expect(plan).toContain("fleet diff docs");
    expect(plan).not.toContain("fleet diff api");
  });
  it("accepts the committed public example through exactly the same parser", () => {
    const data = JSON.parse(
      readFileSync(new URL("../public/example.json", import.meta.url), "utf8"),
    ) as { agents: unknown; check: unknown };
    const example = parseReports(data.agents, data.check);
    expect(example.agents.map((a) => [a.name, a.validation])).toEqual(
      report.agents.map((a) => [a.name, a.validation]),
    );
    expect(example.check.collisions.map((c) => c.file)).toEqual(
      report.check.collisions.map((c) => c.file),
    );
  });
  it("rejects mismatched pairs and unsafe command identities", () => {
    expect(() =>
      parseReports(report.agents, { ...report.check, agentsChecked: 1 }),
    ).toThrow(/Export both/);
    expect(() =>
      parseReports(
        [{ ...report.agents[0], name: "api;curl evil" }],
        report.check,
      ),
    ).toThrow();
    expect(() =>
      parseReports(report.agents, {
        ...report.check,
        collisions: [{ file: "src.txt", agents: ["api", "absent"] }],
      }),
    ).toThrow();
    expect(() =>
      parseReports(report.agents, { ...report.check, agentFiles: {} }),
    ).toThrow();
  });
  it("handles BOM exports, empty fleets and malformed or oversized input honestly", () => {
    expect(parseJSON("\uFEFF[]")).toEqual([]);
    expect(() => parseJSON("invalid")).toThrow(/Could not read/);
    expect(() => parseJSON(" ".repeat(1024 * 1024 + 1))).toThrow(/under 1 MB/);
    expect(
      parseReports([], {
        collisions: [],
        prediction: "files",
        agentsChecked: 0,
        agentFiles: {},
      }).agents,
    ).toHaveLength(0);
  });
  it("holds actual uncommitted work and never suggests certifying its branch", async () => {
    const repo = await makeTempRepo();
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    try {
      await spawn("dirty", { cwd: repo.root });
      writeFileSync(
        path.join(worktreePath(repo.root, "dirty"), "draft.txt"),
        "unfinished\n",
      );
      const data = await collectDashboard(repo.root);
      const dirty = parseReports(data.listings, data.check);
      const gate = gateFor(dirty.agents[0]!, dirty);
      expect(gate.reasons.join(" ")).toContain("uncommitted");
      expect(gate.commands).not.toContain("fleet validate dirty");
    } finally {
      log.mockRestore();
      repo.cleanup();
    }
  });
});

describe("detection mode stays explicit", () => {
  it("rejects simulated verdicts under file-only detection and holds an honest file-only snapshot", () => {
    expect(() =>
      parseReports(report.agents, { ...report.check, prediction: "files" }),
    ).toThrow();
    const files = parseReports(report.agents, {
      ...report.check,
      prediction: "files",
      cleanMerges: [],
      collisions: report.check.collisions.map(({ file, agents }) => ({
        file,
        agents,
      })),
    });
    const docs = files.agents.find((agent) => agent.name === "docs")!;
    expect(gateFor(docs, files).tone).toBe("hold");
    expect(gateFor(docs, files).reasons.join(" ")).toContain(
      "File-only detection",
    );
  });
});
