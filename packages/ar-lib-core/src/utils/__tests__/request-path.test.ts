import { describe, expect, it } from 'vitest';
import { hasMalformedPercentEscape } from '../request-path';

describe('hasMalformedPercentEscape', () => {
  it.each(['/a%', '/a%z', '/a%zz', '/a%2', '/a%6%34cr', '/a%2%35', '/%e0%a4%a', '/a/%/b'])(
    'finds a malformed escape in %s',
    (path) => {
      expect(hasMalformedPercentEscape(`https://t.example${path}`)).toBe(true);
    }
  );

  it.each(['/a', '/a%64', '/a%2F', '/a%25', '/report%2520final', '/%c0%af', '/%ff', '/a%FF%00'])(
    'accepts %s (well formed, even when not valid UTF-8)',
    (path) => {
      expect(hasMalformedPercentEscape(`https://t.example${path}?q=%zz`)).toBe(false);
    }
  );

  it('does not look at the query or fragment, and fails closed on a URL it cannot parse', () => {
    expect(hasMalformedPercentEscape('https://t.example/a?x=%')).toBe(false);
    expect(hasMalformedPercentEscape('not a url')).toBe(true);
  });
});
