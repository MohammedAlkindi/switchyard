import { describe, expect, it } from 'vitest';

import { safeRedirectPath } from '../safe-path.js';

describe('safeRedirectPath', () => {
  it('allows an ordinary same-origin path', () => {
    expect(safeRedirectPath('/dashboard')).toBe('/dashboard');
    expect(safeRedirectPath('/dashboard/abc?x=1')).toBe('/dashboard/abc?x=1');
  });

  it('rejects an absolute URL to another origin', () => {
    // The open-redirect this exists to prevent: a crafted callback link that
    // bounces a freshly-authenticated user to an attacker's site.
    expect(safeRedirectPath('https://evil.example.com', '/dashboard')).toBe('/dashboard');
    expect(safeRedirectPath('http://evil.example.com', '/dashboard')).toBe('/dashboard');
  });

  it('rejects a protocol-relative URL', () => {
    // "//evil.com" starts with a slash but is a different origin.
    expect(safeRedirectPath('//evil.example.com', '/dashboard')).toBe('/dashboard');
  });

  it('rejects a backslash-prefixed path some browsers treat as protocol-relative', () => {
    expect(safeRedirectPath('/\\evil.example.com', '/dashboard')).toBe('/dashboard');
  });

  it('rejects control characters used to smuggle a scheme', () => {
    expect(safeRedirectPath('/\x00//evil.example.com', '/dashboard')).toBe('/dashboard');
    expect(safeRedirectPath('/\n/evil.example.com', '/dashboard')).toBe('/dashboard');
    expect(safeRedirectPath('/\t/evil.example.com', '/dashboard')).toBe('/dashboard');
  });

  it('falls back on empty, null and undefined', () => {
    expect(safeRedirectPath(null, '/x')).toBe('/x');
    expect(safeRedirectPath(undefined, '/x')).toBe('/x');
    expect(safeRedirectPath('', '/x')).toBe('/x');
  });

  it('rejects a scheme-relative value with no leading slash', () => {
    expect(safeRedirectPath('evil.example.com', '/x')).toBe('/x');
    expect(safeRedirectPath('javascript:alert(1)', '/x')).toBe('/x');
  });
});
