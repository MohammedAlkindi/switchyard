import { describe, expect, it } from 'vitest';

import { parseArgs } from '../cli.js';

const HOME = 'C:\\Users\\jdoe';

describe('parseArgs', () => {
  it('defaults to the Claude Code transcript root and the conservative cache rate', () => {
    const o = parseArgs([], HOME);
    expect(o.root.endsWith('projects')).toBe(true);
    expect(o.ttl).toBe('5m');
    expect(o.showPaths).toBe(false);
    expect(o.json).toBe(false);
    expect(o.unknown).toEqual([]);
  });

  it('accepts both --flag value and --flag=value forms', () => {
    expect(parseArgs(['--cache-ttl', '1h'], HOME).ttl).toBe('1h');
    expect(parseArgs(['--cache-ttl=1h'], HOME).ttl).toBe('1h');
    expect(parseArgs(['--top=5'], HOME).top).toBe(5);
  });

  it('ignores an invalid cache-ttl rather than charging a made-up rate', () => {
    expect(parseArgs(['--cache-ttl=1hr'], HOME).ttl).toBe('5m');
    expect(parseArgs(['--cache-ttl=banana'], HOME).ttl).toBe('5m');
  });

  it('ignores a nonsensical --top', () => {
    expect(parseArgs(['--top=0'], HOME).top).toBe(20);
    expect(parseArgs(['--top=-4'], HOME).top).toBe(20);
    expect(parseArgs(['--top=abc'], HOME).top).toBe(20);
  });

  it('collects unrecognised flags so a typo is not silently ignored', () => {
    // The failure this prevents: `--show-path` (singular) quietly doing nothing
    // and the user believing their paths were shown.
    const o = parseArgs(['--show-path', '--bogus'], HOME);
    expect(o.unknown).toEqual(['--show-path', '--bogus']);
    expect(o.showPaths).toBe(false);
  });

  it('does not treat a bare value as an unknown flag', () => {
    expect(parseArgs(['--root', '/tmp/x'], HOME).unknown).toEqual([]);
  });

  it('recognises the real flags', () => {
    const o = parseArgs(['--json', '--show-paths'], HOME);
    expect(o.json).toBe(true);
    expect(o.showPaths).toBe(true);
    expect(o.unknown).toEqual([]);
  });
});
