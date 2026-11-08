import { describe, expect, it } from 'vitest';
import {
  formatLoginUIDarkColors,
  isValidLoginUIThemeColor,
  LOGIN_UI_THEME_COLOR_NAMES,
  loginUIThemeColorKey,
  parseLoginUIDarkColors,
} from '../login-ui-theme-colors';

describe('login UI theme colours', () => {
  it('names each light-mode setting after its colour', () => {
    expect(loginUIThemeColorKey('form_area')).toBe('login-ui.form_area_color');
    expect(loginUIThemeColorKey('header_background')).toBe('login-ui.header_background_color');
    expect(new Set(LOGIN_UI_THEME_COLOR_NAMES).size).toBe(LOGIN_UI_THEME_COLOR_NAMES.length);
  });

  it('accepts hex and rgb() colours, and only solid ones for the accent', () => {
    for (const value of ['#fff', '#123456', '#12345680', 'rgb(1, 2, 3)', 'rgba(1,2,3,0.5)']) {
      expect(isValidLoginUIThemeColor('background', value), value).toBe(true);
    }
    for (const value of ['', 'red', '#12', 'rgb(256, 0, 0)', 'url(x)', 'var(--x)', 12]) {
      expect(isValidLoginUIThemeColor('background', value), String(value)).toBe(false);
    }
    expect(isValidLoginUIThemeColor('accent', '#123456')).toBe(true);
    expect(isValidLoginUIThemeColor('accent', '#12345680')).toBe(false);
  });

  it('reads only known colours with valid values', () => {
    expect(
      parseLoginUIDarkColors(
        JSON.stringify({
          accent: '#93aef2',
          link: ' #a0c4ff ',
          background: 'red',
          unknown: '#000000',
          header_text: 7,
        })
      )
    ).toEqual({ accent: '#93aef2', link: '#a0c4ff' });
    for (const stored of [undefined, '', 'not json', '[]', 'null', '"#fff"', 3]) {
      expect(parseLoginUIDarkColors(stored)).toEqual({});
    }
    expect(
      parseLoginUIDarkColors(JSON.stringify({ accent: '#000', pad: 'x'.repeat(3000) }))
    ).toEqual({});
  });

  it('writes the valid colours in a fixed order, and nothing for none', () => {
    const stored = formatLoginUIDarkColors({
      footer_text: '#eeeeee',
      background: '#101010',
      accent: '#12345680',
    });
    expect(stored).toBe('{"background":"#101010","footer_text":"#eeeeee"}');
    expect(parseLoginUIDarkColors(stored)).toEqual({
      background: '#101010',
      footer_text: '#eeeeee',
    });
    expect(formatLoginUIDarkColors({})).toBe('');
    expect(formatLoginUIDarkColors({ background: '' })).toBe('');
  });
});
