import { describe, it, expect } from 'vitest';

import { projectMount, projectSlug } from '../src/project-setup.js';

describe('projectSlug', () => {
  it('lowercases and hyphenates names', () => {
    expect(projectSlug('Tide App')).toBe('tide-app');
    expect(projectSlug('  Zele - chat! ')).toBe('zele-chat');
    expect(projectSlug('Café Ünder')).toBe('cafe-under');
  });

  it('returns empty when nothing usable is left', () => {
    expect(projectSlug('!!!')).toBe('');
  });

  it('caps the length without a trailing hyphen', () => {
    const slug = projectSlug(`${'a'.repeat(63)} b`);
    expect(slug.length).toBeLessThanOrEqual(64);
    expect(slug.endsWith('-')).toBe(false);
  });
});

describe('projectMount', () => {
  it('mounts ~/Documents/koko/<slug> read-write under its own name', () => {
    expect(projectMount('tide-app')).toEqual({
      hostPath: '~/Documents/koko/tide-app',
      containerPath: 'tide-app',
      readonly: false,
    });
  });
});
