import { describe, expect, it } from 'vitest';
import { declaredScreenExits, screenRoutingHandle } from '../runtime-screen-exits';

const screen = {
  fields: [
    { field: 'name', label: 'Name', block_type: 'text_input' },
    { field: 'link.skip', label: 'Later', block_type: 'link', link_action: 'skip' },
    {
      field: 'link.social',
      label: 'Use a social account',
      block_type: 'link',
      link_action: 'exit',
      link_exit: 'social',
    },
    {
      field: 'link.hidden',
      label: 'Hidden',
      block_type: 'link',
      link_action: 'exit',
      link_exit: 'hidden_way',
      display_condition: { mode: 'hidden' },
    },
    { field: 'link.help', label: 'Help', block_type: 'link', href: '/help' },
    { field: 'link.back', label: 'Back', block_type: 'link', link_action: 'back' },
  ],
};

describe('the exits of a screen', () => {
  it('are named by its shown link parts, in order', () => {
    expect(declaredScreenExits(screen)).toEqual(['skipped', 'social']);
    expect(declaredScreenExits(null)).toEqual([]);
    expect(declaredScreenExits({ fields: 'nope' })).toEqual([]);
  });

  it('take their own edge when the Flow connects one', () => {
    expect(screenRoutingHandle(screen, 'social', ['submitted', 'social'])).toBe('social');
    expect(screenRoutingHandle(screen, 'skipped', ['submitted', 'skipped'])).toBe('skipped');
  });

  it('follow the submit when the Flow connects none', () => {
    expect(screenRoutingHandle(screen, 'social', ['submitted'])).toBe('submitted');
    expect(screenRoutingHandle(screen, 'skipped', ['submitted'])).toBe('submitted');
    // Routed as the submit itself, never by an edge of another name the submit would not take.
    expect(screenRoutingHandle(screen, 'social', [undefined])).toBe('submitted');
    expect(screenRoutingHandle(screen, 'social', ['removed_exit'])).toBe('submitted');
    expect(screenRoutingHandle(screen, 'social', [])).toBe('submitted');
  });

  it('leave the submit and the screen node’s own handles as they are', () => {
    expect(screenRoutingHandle(screen, 'submitted', ['social'])).toBe('submitted');
    expect(screenRoutingHandle(screen, null, ['submitted'])).toBeNull();
    // A screen with no skip part keeps `skipped` only as its code input's way back.
    const code = { fields: [{ field: 'code', block_type: 'code_input_widget' }] };
    expect(screenRoutingHandle(code, 'skipped', ['submitted'])).toBe('skipped');
    expect(screenRoutingHandle({ fields: [] }, 'skipped', ['skipped'])).toBeUndefined();
  });

  it('offer none from a part in a hidden row', () => {
    const rows = {
      fields: [
        { field: 'row', block_type: 'layout_row', display_condition: { mode: 'hidden' } },
        { field: 'link.a', block_type: 'link', link_action: 'exit', link_exit: 'bypass' },
        { field: 'row2', block_type: 'layout_row' },
        { field: 'link.b', block_type: 'link', link_action: 'exit', link_exit: 'shown' },
      ],
    };
    expect(declaredScreenExits(rows)).toEqual(['shown']);
    expect(screenRoutingHandle(rows, 'bypass', ['bypass'])).toBeUndefined();
    // A skip there is no skip either, edge or not; nor a code input there.
    const hiddenSkip = {
      fields: [
        { field: 'row', block_type: 'layout_row', display_condition: { mode: 'hidden' } },
        { field: 'link.skip', block_type: 'link', link_action: 'skip' },
        { field: 'code', block_type: 'code_input_widget' },
      ],
    };
    expect(screenRoutingHandle(hiddenSkip, 'skipped', ['skipped'])).toBeUndefined();
    expect(screenRoutingHandle(hiddenSkip, 'skipped', [])).toBeUndefined();
  });

  it('offer no exit a part does not name, nor one of a hidden part', () => {
    expect(screenRoutingHandle(screen, 'admin', ['admin'])).toBeUndefined();
    expect(screenRoutingHandle(screen, 'hidden_way', ['hidden_way'])).toBeUndefined();
  });
});
