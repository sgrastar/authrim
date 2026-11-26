/**
 * Direct-child lookups on childless nodes, time helpers and the resource limits of parseSAMLXml,
 * pinned at their exact boundaries.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  SAML_XML_LIMITS,
  base64UrlDecode,
  base64UrlEncode,
  findDirectChildElement,
  findDirectChildElements,
  offsetDateTime,
  parseSAMLXml,
  parseXml,
  parseXmlBoolean,
} from '../xml-utils';

function must<T>(value: T | null | undefined): T {
  if (value === null || value === undefined) {
    throw new Error('expected a value');
  }
  return value;
}

describe('direct child lookup', () => {
  it('returns nothing for a node without children (a text node)', () => {
    const doc = parseXml('<a xmlns="urn:x">text<b/></a>');
    const textNode = must(doc.documentElement.firstChild);

    expect(findDirectChildElement(textNode, 'urn:x', 'b')).toBeNull();
    expect(findDirectChildElements(textNode, 'urn:x', 'b')).toEqual([]);
  });

  it('matches only direct children with the exact namespace and local name', () => {
    const doc = parseXml(
      '<a xmlns="urn:x"><b id="1"/><c><b id="nested"/></c><b xmlns="urn:y" id="other"/><b id="2"/></a>'
    );
    const root = doc.documentElement;

    expect((must(findDirectChildElement(root, 'urn:x', 'b')) as Element).getAttribute('id')).toBe(
      '1'
    );
    expect(
      findDirectChildElements(root, 'urn:x', 'b').map((el: Element) => el.getAttribute('id'))
    ).toEqual(['1', '2']);
    expect(findDirectChildElement(root, 'urn:x', 'missing')).toBeNull();
  });
});

describe('offsetDateTime', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('adds and subtracts seconds from the current time', () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-03-04T05:06:07.890Z'));

    expect(offsetDateTime(0)).toBe('2026-03-04T05:06:07Z');
    expect(offsetDateTime(90)).toBe('2026-03-04T05:07:37Z');
    expect(offsetDateTime(-3600)).toBe('2026-03-04T04:06:07Z');
  });
});

describe('base64url and boolean helpers', () => {
  it('drops padding when encoding and restores it when decoding', () => {
    expect(base64UrlEncode('a')).toBe('YQ');
    expect(base64UrlEncode('ab')).toBe('YWI');
    expect(base64UrlDecode('YQ')).toBe('a');
    expect(base64UrlDecode('YWI')).toBe('ab');
    expect(base64UrlDecode(base64UrlEncode('???>>>'))).toBe('???>>>');
    expect(base64UrlEncode('???>>>')).toBe('Pz8_Pj4-');
  });

  it('parses the XML Schema boolean lexical forms and rejects anything else', () => {
    expect(parseXmlBoolean(' true ')).toBe(true);
    expect(parseXmlBoolean('1')).toBe(true);
    expect(parseXmlBoolean('false')).toBe(false);
    expect(parseXmlBoolean('0')).toBe(false);
    expect(parseXmlBoolean(null)).toBeUndefined();
    expect(parseXmlBoolean(undefined)).toBeUndefined();
    expect(() => parseXmlBoolean('yes')).toThrow('Invalid XML boolean value: yes');
  });
});

describe('parseSAMLXml limits', () => {
  const pad = (length: number, prefix = '<a>', suffix = '</a>') =>
    prefix + 'x'.repeat(length - prefix.length - suffix.length) + suffix;

  it('accepts a message of exactly maxChars and rejects one character more', () => {
    expect(() => parseSAMLXml(pad(SAML_XML_LIMITS.maxChars))).not.toThrow();
    expect(() => parseSAMLXml(pad(SAML_XML_LIMITS.maxChars + 1))).toThrow(
      'SAML XML exceeds maximum size'
    );
  });

  it('accepts exactly maxMarkupTokens "<" characters and rejects one more', () => {
    // <a> plus (n-2) <b/> children plus </a> is n markup tokens.
    const withTokens = (n: number) => `<a>${'<b/>'.repeat(n - 2)}</a>`;
    expect(() => parseSAMLXml(withTokens(SAML_XML_LIMITS.maxMarkupTokens))).not.toThrow();
    expect(() => parseSAMLXml(withTokens(SAML_XML_LIMITS.maxMarkupTokens + 1))).toThrow(
      'SAML XML exceeds maximum markup complexity'
    );
  });

  it('accepts depth maxDepth and rejects maxDepth + 1', () => {
    // The document node is depth 0, so n nested elements put the innermost at depth n.
    const nested = (n: number) => '<a>'.repeat(n) + '</a>'.repeat(n);
    expect(() => parseSAMLXml(nested(SAML_XML_LIMITS.maxDepth))).not.toThrow();
    expect(() => parseSAMLXml(nested(SAML_XML_LIMITS.maxDepth + 1))).toThrow(
      'SAML XML exceeds maximum depth'
    );
  });

  it('counts attributes across the whole document', () => {
    const attrs = (n: number) => {
      const per = 100;
      const elements: string[] = [];
      for (let i = 0; i < n; i += per) {
        const count = Math.min(per, n - i);
        elements.push(`<b ${Array.from({ length: count }, (_, k) => `a${k}="1"`).join(' ')}/>`);
      }
      return `<a>${elements.join('')}</a>`;
    };
    expect(() => parseSAMLXml(attrs(SAML_XML_LIMITS.maxAttributes))).not.toThrow();
    expect(() => parseSAMLXml(attrs(SAML_XML_LIMITS.maxAttributes + 1))).toThrow(
      'SAML XML exceeds maximum attribute count'
    );
  });

  it('rejects processing instructions but allows a leading XML declaration and BOM', () => {
    expect(() => parseSAMLXml('<?xml version="1.0" encoding="UTF-8"?><a/>')).not.toThrow();
    expect(() => parseSAMLXml('﻿  <?xml version="1.0"?><a/>')).not.toThrow();
    expect(() => parseSAMLXml('<?XML version="1.0"?><a/>')).not.toThrow();
    expect(() => parseSAMLXml('<a><?pi data?></a>')).toThrow(
      'SAML XML processing instructions are not allowed'
    );
    expect(() => parseSAMLXml('<?xml version="1.0"?><?pi data?><a/>')).toThrow(
      'SAML XML processing instructions are not allowed'
    );
    expect(() => parseSAMLXml('<a/><?xml version="1.0"?>')).toThrow(
      'SAML XML processing instructions are not allowed'
    );
  });
});
