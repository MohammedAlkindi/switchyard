import { writeFileSync } from "node:fs";
import path from "node:path";
import { collectDashboard } from "../src/commands/dashboard.js";
import { spawn } from "../src/commands/spawn.js";
import { validate } from "../src/commands/validate.js";
import { commitFile, makeTempRepo, worktreePath } from "./helpers.js";

/** Real Git evidence for the public walkthrough; no workers and no real repository state. */
export async function makeReviewFixture() {
  const repo = await makeTempRepo();
  try {
    writeFileSync(
      path.join(repo.root, ".fleetrc.json"),
      JSON.stringify({ validate: 'node -e "process.exit(0)"' }),
    );
    for (const name of ["api", "auth", "docs"])
      await spawn(name, { cwd: repo.root });
    await commitFile(
      worktreePath(repo.root, "api"),
      "src.txt",
      "api route\n",
      "feat: api route",
    );
    await commitFile(
      worktreePath(repo.root, "auth"),
      "src.txt",
      "auth route\n",
      "feat: auth route",
    );
    await commitFile(
      worktreePath(repo.root, "docs"),
      "guide.md",
      "# Worktree guide\n",
      "docs: guide",
    );
    for (const name of ["api", "auth", "docs"])
      await validate(name, { cwd: repo.root });
    await commitFile(
      worktreePath(repo.root, "auth"),
      "auth.txt",
      "More work after validation\n",
      "feat: extend auth",
    );
    const { listings, check } = await collectDashboard(repo.root);
    return { agents: listings, check };
  } finally {
    repo.cleanup();
  }
}
