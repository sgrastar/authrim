/**
 * The xmldom error handler wired by parseXml: severities it maps to exceptions, and the
 * defensive parsererror check. xmldom 0.8 rarely emits fatal errors, so the parser is replaced.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

const parser = vi.hoisted(
  (): { handler: null | ((level: string, message: string) => void); result: unknown } => ({
    handler: null,
    result: null,
  })
);

vi.mock('@xmldom/xmldom', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@xmldom/xmldom')>();
  class FakeDOMParser {
    constructor(options: { errorHandler: (level: string, message: string) => void }) {
      parser.handler = options.errorHandler;
    }
    parseFromString(): unknown {
      return parser.result;
    }
  }
  return { ...actual, DOMParser: FakeDOMParser };
});

import { parseXml } from '../xml-utils';

function handler(): (level: string, message: string) => void {
  if (!parser.handler) {
    throw new Error('parser was not constructed');
  }
  return parser.handler;
}

describe('parseXml error handler', () => {
  beforeEach(() => {
    parser.handler = null;
    parser.result = { getElementsByTagName: () => [] };
    parseXml('<a/>');
  });

  it('turns error-level reports into "XML Parse Error"', () => {
    expect(() => handler()('error', 'bad token')).toThrow('XML Parse Error: bad token');
  });

  it('turns fatalError-level reports into "XML Fatal Error"', () => {
    expect(() => handler()('fatalError', 'broken')).toThrow('XML Fatal Error: broken');
  });

  it('ignores warnings and unknown levels', () => {
    expect(() => handler()('warning', 'minor')).not.toThrow();
    expect(() => handler()('info', 'note')).not.toThrow();
  });
});

describe('parseXml parsererror check', () => {
  it('fails when the parsed document contains a parsererror element', () => {
    parser.result = { getElementsByTagName: () => [{ textContent: 'syntax problem' }] };

    expect(() => parseXml('<a/>')).toThrow('XML Parse Error: syntax problem');
  });

  it('returns the parsed document when there is no parsererror element', () => {
    const doc = { getElementsByTagName: () => [] };
    parser.result = doc;

    expect(parseXml('<a/>')).toBe(doc);
  });
});
