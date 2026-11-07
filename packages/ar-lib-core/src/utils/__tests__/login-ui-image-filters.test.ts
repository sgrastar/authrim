import { describe, expect, it } from 'vitest';
import {
  formatLoginUIImageFilters,
  loginUIImageFilterCss,
  parseLoginUIImageFilters,
} from '../login-ui-image-filters';

describe('login UI image filters', () => {
  it('reads the stored filters in order', () => {
    expect(parseLoginUIImageFilters('hue-rotate:200;blur:4')).toEqual([
      { name: 'hue-rotate', value: 200 },
      { name: 'blur', value: 4 },
    ]);
  });

  it('reads nothing from a value that is not text, empty or too long', () => {
    expect(parseLoginUIImageFilters(undefined)).toEqual([]);
    expect(parseLoginUIImageFilters(42)).toEqual([]);
    expect(parseLoginUIImageFilters('')).toEqual([]);
    expect(parseLoginUIImageFilters(`blur:4;${'x'.repeat(300)}`)).toEqual([]);
  });

  it('skips unknown filters, values out of range, fractions and repeats', () => {
    expect(
      parseLoginUIImageFilters(
        'opacity:50;blur:21;brightness:-1;contrast:1.5;sepia:40;sepia:90;url(x):1;invert:100'
      )
    ).toEqual([
      { name: 'sepia', value: 40 },
      { name: 'invert', value: 100 },
    ]);
  });

  it('refuses anything that could break out of a CSS value', () => {
    expect(parseLoginUIImageFilters('blur:4);background:url(x)')).toEqual([]);
    expect(parseLoginUIImageFilters('blur:4 } body { color:red')).toEqual([]);
  });

  it('writes valid filters once each, in order', () => {
    expect(
      formatLoginUIImageFilters([
        { name: 'saturate', value: 150 },
        { name: 'blur', value: 2 },
        { name: 'saturate', value: 10 },
        { name: 'blur', value: 99 },
      ])
    ).toBe('saturate:150;blur:2');
  });

  it('builds the CSS filter value with each unit', () => {
    expect(
      loginUIImageFilterCss([
        { name: 'blur', value: 4 },
        { name: 'brightness', value: 120 },
        { name: 'hue-rotate', value: 200 },
      ])
    ).toBe('blur(4px) brightness(120%) hue-rotate(200deg)');
    expect(loginUIImageFilterCss([])).toBe('');
  });
});
