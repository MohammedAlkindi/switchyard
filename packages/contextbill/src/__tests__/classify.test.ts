import { describe, expect, it } from 'vitest';

import { classify, isMutatingTool, mcpServer } from '../classify.js';

describe('classify', () => {
  it('buckets the built-in tools', () => {
    expect(classify('Read')).toBe('files');
    expect(classify('Edit')).toBe('files');
    expect(classify('Bash')).toBe('shell');
    expect(classify('PowerShell')).toBe('shell');
    expect(classify('WebSearch')).toBe('web');
    expect(classify('Agent')).toBe('subagents');
    expect(classify('Task')).toBe('subagents');
  });

  it('puts browser MCP tools in browser, not connectors', () => {
    // This ordering is the whole reason browser is tested first. Browser tools
    // are MCP tools; a naive prefix check hides the largest line item on some
    // machines inside a generic "connectors" bucket.
    expect(classify('mcp__claude-in-chrome__navigate')).toBe('browser');
    expect(classify('mcp__Claude_Browser__computer')).toBe('browser');
    expect(classify('mcp__github__search_code')).toBe('connectors');
  });

  it('falls back to other for unknown tools', () => {
    expect(classify('SomeFutureTool')).toBe('other');
    expect(classify('')).toBe('other');
  });

  it('counts only real write tools as producing a file', () => {
    expect(isMutatingTool('Write')).toBe(true);
    expect(isMutatingTool('Edit')).toBe(true);
    expect(isMutatingTool('NotebookEdit')).toBe(true);
    expect(isMutatingTool('Read')).toBe(false);
    // Bash can write files. It deliberately does not count — see classify.ts.
    expect(isMutatingTool('Bash')).toBe(false);
  });
});

describe('mcpServer', () => {
  it('names the server a tool belongs to', () => {
    expect(mcpServer('mcp__github__create_branch')).toBe('github');
    expect(mcpServer('mcp__claude-in-chrome__navigate')).toBe('claude-in-chrome');
  });

  it('passes an opaque server id through rather than guessing at it', () => {
    // claude.ai connectors are UUIDs. Rendering the raw id is honest; inventing
    // a friendly name for it would be a fabrication in a cost report.
    expect(mcpServer('mcp__aed0a7ff-182d-4b72-9c71-7329cc235f29__send_message')).toBe(
      'aed0a7ff-182d-4b72-9c71-7329cc235f29',
    );
  });

  it('returns null for anything that is not an MCP tool', () => {
    expect(mcpServer('Bash')).toBe(null);
    expect(mcpServer('Read')).toBe(null);
    expect(mcpServer('mcp__')).toBe(null);
  });

  it('handles a server with no tool segment', () => {
    expect(mcpServer('mcp__server')).toBe('server');
  });
});
