/**
 * An expected, user-facing failure (bad input, missing agent, dirty worktree, …).
 * The CLI prints the message in red and exits 1 — no stack trace.
 */
export class FleetError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'FleetError';
  }
}
