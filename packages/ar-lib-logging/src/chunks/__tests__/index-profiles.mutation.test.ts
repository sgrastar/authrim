import { describe, expect, it } from 'vitest';
import {
  LOG_CHUNK_INDEX_PROFILES,
  filterLogChunkIndexedFields,
  getLogChunkIndexProfile,
} from '../index-profiles';
import { LOG_TYPES } from '../../registry';

const field = (name: string, type: 'string' | 'number') => ({ name, type });
const COMMON = [
  field('eventType', 'string'),
  field('eventCategory', 'string'),
  field('result', 'string'),
  field('severity', 'string'),
  field('errorCode', 'string'),
  field('clientId', 'string'),
  field('requestId', 'string'),
  field('durationMs', 'number'),
];

describe('the index profiles', () => {
  it('index the fields each log type is searched by, and no others', () => {
    expect(LOG_CHUNK_INDEX_PROFILES).toStrictEqual({
      normal: { name: 'normal', logTypes: ['normal'], fields: COMMON, maxStringLength: 256 },
      audit: { name: 'audit', logTypes: ['audit'], fields: COMMON, maxStringLength: 256 },
      admin_audit: {
        name: 'admin_audit',
        logTypes: ['admin_audit'],
        fields: [
          field('action', 'string'),
          field('resourceType', 'string'),
          field('resourceId', 'string'),
          field('result', 'string'),
          field('severity', 'string'),
          field('adminId', 'string'),
          field('requestId', 'string'),
        ],
        maxStringLength: 256,
      },
      security: { name: 'security', logTypes: ['security'], fields: COMMON, maxStringLength: 256 },
      pii: {
        name: 'pii',
        logTypes: ['pii'],
        fields: [
          field('changeType', 'string'),
          field('actorType', 'string'),
          field('legalBasis', 'string'),
          field('requestId', 'string'),
          field('affectedFieldCount', 'number'),
        ],
        maxStringLength: 256,
      },
      diagnostic: {
        name: 'diagnostic',
        logTypes: ['diagnostic'],
        fields: [
          field('surface', 'string'),
          field('category', 'string'),
          field('severity', 'string'),
          field('requestId', 'string'),
          field('durationMs', 'number'),
        ],
        maxStringLength: 256,
      },
      job: {
        name: 'job',
        logTypes: ['job'],
        fields: [
          field('jobType', 'string'),
          field('jobId', 'string'),
          field('status', 'string'),
          field('attempt', 'number'),
          field('durationMs', 'number'),
        ],
        maxStringLength: 256,
      },
      webhook: {
        name: 'webhook',
        logTypes: ['webhook'],
        fields: [
          field('webhookId', 'string'),
          field('eventType', 'string'),
          field('status', 'string'),
          field('httpStatus', 'number'),
          field('attempt', 'number'),
        ],
        maxStringLength: 256,
      },
      operational: {
        name: 'operational',
        logTypes: ['operational'],
        fields: [
          field('surface', 'string'),
          field('eventType', 'string'),
          field('severity', 'string'),
          field('status', 'string'),
          field('errorClass', 'string'),
        ],
        maxStringLength: 256,
      },
    });
  });

  it('are found by name or by the log type they serve', () => {
    for (const type of LOG_TYPES) {
      expect(getLogChunkIndexProfile(type)).toBe(LOG_CHUNK_INDEX_PROFILES[type]);
    }
    expect(getLogChunkIndexProfile('audit').name).toBe('audit');
  });

  it('are not found for an unknown name, or the name of an inherited object member', () => {
    for (const name of [
      'nope',
      '',
      'Audit',
      'toString',
      'constructor',
      '__proto__',
      'hasOwnProperty',
    ]) {
      expect(() => getLogChunkIndexProfile(name)).toThrow(
        `unsupported_log_chunk_index_profile:${name}`
      );
    }
  });
});

describe('filterLogChunkIndexedFields', () => {
  it('keeps nothing for no fields', () => {
    expect(filterLogChunkIndexedFields('audit', undefined)).toBeUndefined();
  });

  it('keeps the fields of the profile whose values have the right type', () => {
    expect(
      filterLogChunkIndexedFields('audit', {
        eventType: 'login',
        result: 'ok',
        durationMs: 12,
        unknown: 'dropped',
        severity: 5,
        errorCode: null,
        clientId: undefined,
        requestId: true,
      })
    ).toStrictEqual({ eventType: 'login', result: 'ok', durationMs: 12 });
  });

  it('puts the fields in the order of the profile', () => {
    const kept = filterLogChunkIndexedFields('audit', {
      durationMs: 1,
      requestId: 'r',
      eventType: 'e',
    });
    expect(Object.keys(kept ?? {})).toEqual(['eventType', 'requestId', 'durationMs']);
  });

  it('keeps finite numbers only, including zero and negatives', () => {
    for (const durationMs of [0, -1, 1.5]) {
      expect(filterLogChunkIndexedFields('audit', { durationMs })).toStrictEqual({ durationMs });
    }
    for (const durationMs of [
      Number.NaN,
      Number.POSITIVE_INFINITY,
      Number.NEGATIVE_INFINITY,
      '5',
      5n,
    ]) {
      expect(filterLogChunkIndexedFields('audit', { durationMs })).toBeUndefined();
    }
  });

  it('keeps strings of any content, even empty, and cuts them at 256 characters', () => {
    expect(filterLogChunkIndexedFields('audit', { eventType: '' })).toStrictEqual({
      eventType: '',
    });
    const at = 'x'.repeat(256);
    expect(filterLogChunkIndexedFields('audit', { eventType: at })).toStrictEqual({
      eventType: at,
    });
    expect(filterLogChunkIndexedFields('audit', { eventType: `${at}y` })).toStrictEqual({
      eventType: at,
    });
    expect(filterLogChunkIndexedFields('audit', { eventType: 'x'.repeat(1000) })).toStrictEqual({
      eventType: at,
    });
  });

  it('never cuts a number', () => {
    expect(filterLogChunkIndexedFields('audit', { durationMs: 12345678901234 })).toStrictEqual({
      durationMs: 12345678901234,
    });
  });

  it('keeps nothing when no field qualifies, and rejects an unknown profile', () => {
    expect(filterLogChunkIndexedFields('audit', {})).toBeUndefined();
    expect(filterLogChunkIndexedFields('audit', { other: 'x' })).toBeUndefined();
    expect(() => filterLogChunkIndexedFields('nope', { a: 'x' })).toThrow(
      'unsupported_log_chunk_index_profile:nope'
    );
    expect(
      filterLogChunkIndexedFields('pii', { affectedFieldCount: 3, changeType: 'x' })
    ).toStrictEqual({
      changeType: 'x',
      affectedFieldCount: 3,
    });
  });
});
