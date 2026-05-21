import { describe, expect, it } from 'vitest';

import {
  filterLogChunkIndexedFields,
  getLogChunkIndexProfile,
  LOG_CHUNK_INDEX_PROFILES,
} from '../index-profiles';

describe('log chunk index profiles', () => {
  it('defines an index profile for every log type', () => {
    expect(Object.keys(LOG_CHUNK_INDEX_PROFILES).sort()).toEqual([
      'admin_audit',
      'audit',
      'diagnostic',
      'job',
      'normal',
      'operational',
      'pii',
      'security',
      'webhook',
    ]);
  });

  it('resolves profile names and log types to stable profiles', () => {
    expect(getLogChunkIndexProfile('audit')).toMatchObject({
      name: 'audit',
      logTypes: ['audit'],
    });
    expect(getLogChunkIndexProfile('webhook')).toMatchObject({
      name: 'webhook',
      logTypes: ['webhook'],
    });
  });

  it('filters indexed fields to allowed primitive fields only', () => {
    expect(
      filterLogChunkIndexedFields('audit', {
        eventType: 'auth.login',
        eventCategory: 'auth',
        result: 'success',
        severity: 'info',
        durationMs: 12,
        nested: { not: 'allowed' },
        changeType: 'update',
      })
    ).toEqual({
      eventType: 'auth.login',
      eventCategory: 'auth',
      result: 'success',
      severity: 'info',
      durationMs: 12,
    });
  });

  it('truncates long string index values', () => {
    const value = 'x'.repeat(300);

    expect(filterLogChunkIndexedFields('operational', { eventType: value })).toEqual({
      eventType: 'x'.repeat(256),
    });
  });
});
