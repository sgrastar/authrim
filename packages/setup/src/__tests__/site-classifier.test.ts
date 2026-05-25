import { describe, expect, it } from 'vitest';
import {
  classifyUiApiSite,
  getSchemefulSite,
  isSameOrigin,
  isSameSite,
} from '../core/site-classifier.js';

describe('site classifier', () => {
  it('classifies identical origins as same-origin', () => {
    expect(classifyUiApiSite('https://auth.example.com', 'https://auth.example.com')).toBe(
      'same-origin'
    );
    expect(isSameOrigin('https://auth.example.com', 'https://auth.example.com')).toBe(true);
  });

  it('classifies same registrable domain origins as same-site cross-origin', () => {
    expect(classifyUiApiSite('https://api.example.com', 'https://admin.example.com')).toBe(
      'same-site-cross-origin'
    );
  });

  it('uses public suffix data for multi-label suffixes', () => {
    expect(classifyUiApiSite('https://api.example.co.jp', 'https://admin.example.co.jp')).toBe(
      'same-site-cross-origin'
    );
    expect(getSchemefulSite('https://admin.example.co.jp')).toBe('https://example.co.jp');
  });

  it('classifies unrelated registrable domains as cross-site', () => {
    expect(classifyUiApiSite('https://www.service-site.com', 'https://admin.example.co.jp')).toBe(
      'cross-site'
    );
  });

  it('treats scheme mismatch as cross-site', () => {
    expect(classifyUiApiSite('https://api.example.com', 'http://admin.example.com')).toBe(
      'cross-site'
    );
    expect(isSameSite('https://api.example.com', 'http://admin.example.com')).toBe(false);
  });

  it('supports an explicit base domain fallback', () => {
    expect(
      classifyUiApiSite('https://api.internal', 'https://admin.internal', {
        baseDomain: 'internal',
      })
    ).toBe('same-site-cross-origin');
  });

  it('does not treat different localhost ports as same-site by default', () => {
    expect(classifyUiApiSite('http://localhost:8786', 'http://localhost:5173')).toBe('cross-site');
  });

  it('allows localhost same-site only with explicit dev option', () => {
    expect(
      classifyUiApiSite('http://localhost:8786', 'http://localhost:5173', {
        allowLocalhostSameSite: true,
      })
    ).toBe('same-site-cross-origin');
  });

  it('throws for invalid URLs', () => {
    expect(() => classifyUiApiSite('not a url', 'https://admin.example.com')).toThrow();
  });
});
