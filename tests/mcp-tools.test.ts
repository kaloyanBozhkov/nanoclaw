import { describe, it, expect } from 'vitest';

import {
  disabledMcpServers,
  findMcpTool,
  formatResetToolsNote,
  formatToolsStatus,
  isMcpEnabled,
  withMcpSetting,
  withResetToolDefaults,
} from '../src/mcp-tools.js';
import { formatHelp } from '../src/help.js';
import type { RegisteredGroup } from '../src/types.js';

const group = (containerConfig?: RegisteredGroup['containerConfig']) =>
  ({
    name: 'G',
    folder: 'g',
    trigger: '@Andy',
    added_at: '',
    containerConfig,
  }) as RegisteredGroup;

describe('mcp tool switches', () => {
  it('uses defaults: only context7 on', () => {
    const g = group();
    expect(isMcpEnabled(g, 'notion')).toBe(false);
    expect(isMcpEnabled(g, 'design')).toBe(false);
    expect(isMcpEnabled(g, 'context7')).toBe(true);
    expect(disabledMcpServers(g).sort()).toEqual([
      'design',
      'notion',
      'pencil',
      'playwright',
    ]);
  });

  it('falls back to enableNotion for existing chats', () => {
    expect(isMcpEnabled(group({ enableNotion: true }), 'notion')).toBe(true);
  });

  it('explicit settings win over defaults', () => {
    const g = group({
      enableNotion: true,
      tools: { notion: false, design: true, playwright: true },
    });
    expect(disabledMcpServers(g).sort()).toEqual(['notion', 'pencil']);
  });

  it('switching keeps enableNotion in step and leaves other config alone', () => {
    const g = withMcpSetting(group({ model: 'm' }), 'Notion', true);
    expect(g.containerConfig).toEqual({
      model: 'm',
      tools: { notion: true },
      enableNotion: true,
    });
    const off = withMcpSetting(g, 'notion', false);
    expect(off.containerConfig?.enableNotion).toBe(false);
    expect(isMcpEnabled(off, 'notion')).toBe(false);
  });

  it('matches names case-insensitively, by id or label', () => {
    expect(findMcpTool('NOTION')?.id).toBe('notion');
    expect(findMcpTool('claude design')?.id).toBe('design');
    expect(findMcpTool('nanoclaw')).toBeUndefined();
  });

  it('lists every tool with its state', () => {
    const text = formatToolsStatus(group({ tools: { design: true } }));
    expect(text).toContain('⚪️ notion (~77k tokens)');
    expect(text).toContain('nanoclaw (~7k tokens)');
    expect(text).toContain('⚪️ pencil');
    expect(text).toContain('🟢 design');
    expect(text).toContain('nanoclaw');
  });

  it('is in /help', () => {
    expect(formatHelp()).toContain('/tools');
  });

  it('/new switches off every default-off tool, keeping other config', () => {
    const { group: g, switchedOff } = withResetToolDefaults(
      group({
        enableNotion: true,
        tools: { design: true, context7: false },
        model: 'm',
      }),
    );
    expect(switchedOff).toEqual(['Notion', 'Claude Design']);
    expect(disabledMcpServers(g).sort()).toEqual([
      'context7',
      'design',
      'notion',
      'pencil',
      'playwright',
    ]);
    expect(g.containerConfig?.model).toBe('m');
  });

  it('/new reports nothing when they were already off', () => {
    const { switchedOff } = withResetToolDefaults(group());
    expect(switchedOff).toEqual([]);
  });

  it('/new always reminds about /tools', () => {
    const quiet = formatResetToolsNote(group(), []);
    expect(quiet).toContain(
      'Tools are off for this new session except context7',
    );
    expect(quiet).toContain('/tools');
    expect(quiet).not.toContain('Just switched off');
    expect(formatResetToolsNote(group(), ['Notion'])).toContain(
      'Just switched off: Notion',
    );
  });
});
