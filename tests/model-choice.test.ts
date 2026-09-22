import { describe, expect, it } from 'vitest';

import {
  AVAILABLE_MODELS,
  modelLabel,
  resolveModelChoice,
} from '../src/config.js';

describe('resolveModelChoice', () => {
  it('resolves a 1-based index', () => {
    expect(resolveModelChoice('1')?.id).toBe(AVAILABLE_MODELS[0].id);
    expect(resolveModelChoice('0')).toBeNull();
    expect(resolveModelChoice(String(AVAILABLE_MODELS.length + 1))).toBeNull();
  });

  it('bare family aliases point at the current generation', () => {
    expect(resolveModelChoice('opus')?.id).toBe('claude-opus-5-5');
    expect(resolveModelChoice('fable')?.id).toBe('claude-fable-5-1');
    expect(resolveModelChoice('sonnet')?.id).toBe('claude-sonnet-5');
    expect(resolveModelChoice('haiku')?.id).toBe('claude-haiku-4-5');
  });

  it('previous generations are reachable by explicit alias or id', () => {
    expect(resolveModelChoice('opus-4.8')?.id).toBe('claude-opus-4-8');
    expect(resolveModelChoice('claude-opus-5')?.id).toBe('claude-opus-5');
    expect(resolveModelChoice('fable-5')?.id).toBe('claude-fable-5');
  });

  it('matches labels case-insensitively and by prefix', () => {
    expect(resolveModelChoice('OPUS 5.5')?.id).toBe('claude-opus-5-5');
    expect(resolveModelChoice('Son')?.id).toBe('claude-sonnet-5');
  });

  it('returns null for unknown or empty input', () => {
    expect(resolveModelChoice('')).toBeNull();
    expect(resolveModelChoice('gpt-5')).toBeNull();
  });

  it('has unique aliases and ids', () => {
    const aliases = new Set(AVAILABLE_MODELS.map((m) => m.alias));
    const ids = new Set(AVAILABLE_MODELS.map((m) => m.id));
    expect(aliases.size).toBe(AVAILABLE_MODELS.length);
    expect(ids.size).toBe(AVAILABLE_MODELS.length);
  });
});

describe('modelLabel', () => {
  it('labels known ids and falls back to the raw id for legacy pins', () => {
    expect(modelLabel('claude-opus-5-5')).toBe('Opus 5.5');
    expect(modelLabel('claude-opus-4-8[1m]')).toBe('claude-opus-4-8[1m]');
  });
});
