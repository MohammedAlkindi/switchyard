import { describe, expect, it } from 'vitest';

import { classify, isMutatingTool } from '../classify.js';

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
