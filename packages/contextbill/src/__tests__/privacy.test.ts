import { describe, expect, it } from 'vitest';

import { homeSlug, redactProject } from '../privacy.js';

describe('homeSlug', () => {
  it('maps a Windows home directory to slug form', () => {
    expect(homeSlug('C:\\Users\\jdoe')).toBe('C--Users-jdoe');
  });

  it('maps a POSIX home directory to slug form', () => {
    expect(homeSlug('/home/jdoe')).toBe('-home-jdoe');
  });
});

describe('redactProject', () => {
  const home = 'C:\\Users\\jdoe';

  it('removes the username and drive from a real project slug', () => {
    // The whole point: this must not reveal that the user is "jdoe".
    const out = redactProject('C--Users-jdoe-work-acme-billing', home);
    expect(out).toBe('work-acme-billing');
    expect(out).not.toContain('jdoe');
    expect(out).not.toContain('C--');
  });

  it('keeps the project name, which is the useful part', () => {
    expect(redactProject('C--Users-jdoe-Github-Ridge', home)).toBe('Github-Ridge');
  });

  it('labels the home directory itself', () => {
    expect(redactProject('C--Users-jdoe', home)).toBe('(home)');
  });

  it('labels a bare drive root', () => {
    expect(redactProject('C--', home)).toBe('(drive root)');
  });

  it('redacts a slug from another machine via the generic pattern', () => {
    // Transcripts copied from a colleague's box still must not leak their name.
    const out = redactProject('D--Users-someone-else-project', home);
    expect(out).not.toContain('someone');
    expect(out).toBe('else-project');
  });

  it('redacts a POSIX slug from another machine', () => {
    const out = redactProject('-home-alice-src-thing', home);
    expect(out).not.toContain('alice');
    expect(out).toBe('src-thing');
  });

  it('leaves a slug with nothing identifying in it alone', () => {
    expect(redactProject('scratch-project', home)).toBe('scratch-project');
  });

  it('handles empty and unknown input', () => {
    expect(redactProject('', home)).toBe('unknown');
    expect(redactProject('unknown', home)).toBe('unknown');
  });
});
