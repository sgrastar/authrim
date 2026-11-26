import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  buildLoggingMessagePayloadKey,
  buildLoggingMessageRedactedSummary,
  writeLoggingMessagePayloadToR2,
} from '../payload';

afterEach(() => {
  vi.useRealTimers();
});

async function sha256Hex(value: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

const keyInput = {
  jobId: 'lmj_1',
  payloadType: 'retry_delivery',
  lane: 'default',
  criticality: 'standard',
  sourceType: 'dlq_item',
  tenantKey: 't_1',
  now: Date.UTC(2026, 0, 2, 3, 4, 5),
} as const;

describe('buildLoggingMessagePayloadKey', () => {
  it('lays the key out by type, criticality, lane, source, tenant and UTC hour', () => {
    expect(buildLoggingMessagePayloadKey(keyInput)).toBe(
      'message-jobs/retry_delivery/criticality=standard/lane=default/source_type=dlq_item/tenant_key=t_1/yyyy=2026/mm=01/dd=02/hh=03/lmj_1.json'
    );
  });

  it('pads the month, day and hour, and does not pad two-digit values', () => {
    expect(
      buildLoggingMessagePayloadKey({ ...keyInput, now: Date.UTC(2026, 11, 31, 23) })
    ).toContain('/yyyy=2026/mm=12/dd=31/hh=23/');
    expect(buildLoggingMessagePayloadKey({ ...keyInput, now: Date.UTC(2026, 8, 9, 0) })).toContain(
      '/yyyy=2026/mm=09/dd=09/hh=00/'
    );
  });

  it('uses the platform for a missing or null tenant, and encodes every segment', () => {
    expect(buildLoggingMessagePayloadKey({ ...keyInput, tenantKey: null })).toContain(
      '/tenant_key=platform/'
    );
    expect(buildLoggingMessagePayloadKey({ ...keyInput, tenantKey: undefined })).toContain(
      '/tenant_key=platform/'
    );
    expect(buildLoggingMessagePayloadKey({ ...keyInput, tenantKey: '' })).toContain(
      '/tenant_key=/'
    );
    const key = buildLoggingMessagePayloadKey({
      ...keyInput,
      jobId: "a b/c!'()*",
      payloadType: 'x/y',
      tenantKey: "t(1)*'!",
    });
    expect(key).toContain('message-jobs/x%2Fy/');
    expect(key).toContain('/tenant_key=t%281%29%2A%27%21/');
    expect(key.endsWith('/a%20b%2Fc%21%27%28%29%2A.json')).toBe(true);
  });

  it('reads the clock when no time is given', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(Date.UTC(2030, 5, 7, 8)));
    expect(buildLoggingMessagePayloadKey({ ...keyInput, now: undefined })).toContain(
      '/yyyy=2030/mm=06/dd=07/hh=08/'
    );
  });
});

describe('buildLoggingMessageRedactedSummary', () => {
  it('summarises each value by kind and redacts sensitive keys', () => {
    expect(
      buildLoggingMessageRedactedSummary({
        z_string: 'abc',
        a_number: 5,
        b_boolean: false,
        c_null: null,
        d_undefined: undefined,
        e_array: [1, 2, 3],
        f_object: { y: 1, b: 2 },
        g_bigint: 10n,
        h_function: () => 1,
        password: 'x',
        Authorization: 'x',
        session_cookie: 'x',
        api_key: 'x',
        client_secret: 'x',
        access_token: 'x',
        signature: 'x',
        credential_ref: 'x',
        request_body: 'x',
      })
    ).toStrictEqual({
      Authorization: '[redacted]',
      a_number: 5,
      access_token: '[redacted]',
      api_key: '[redacted]',
      b_boolean: false,
      c_null: null,
      client_secret: '[redacted]',
      credential_ref: '[redacted]',
      d_undefined: null,
      e_array: { type: 'array', length: 3 },
      f_object: { type: 'object', keys: ['b', 'y'] },
      g_bigint: { type: 'bigint' },
      h_function: { type: 'function' },
      password: '[redacted]',
      request_body: '[redacted]',
      session_cookie: '[redacted]',
      signature: '[redacted]',
      z_string: { type: 'string', length: 3 },
    });
  });

  it('lists keys in order', () => {
    expect(Object.keys(buildLoggingMessageRedactedSummary({ b: 1, a: 2, c: 3 }))).toEqual([
      'a',
      'b',
      'c',
    ]);
  });

  it('summarises a payload that is not a plain object as one value', () => {
    expect(buildLoggingMessageRedactedSummary(null)).toStrictEqual({ payload: null });
    expect(buildLoggingMessageRedactedSummary(undefined)).toStrictEqual({ payload: null });
    expect(buildLoggingMessageRedactedSummary('text')).toStrictEqual({
      payload: { type: 'string', length: 4 },
    });
    expect(buildLoggingMessageRedactedSummary(5)).toStrictEqual({ payload: 5 });
    expect(buildLoggingMessageRedactedSummary(true)).toStrictEqual({ payload: true });
    expect(buildLoggingMessageRedactedSummary([1, 2])).toStrictEqual({
      payload: { type: 'array', length: 2 },
    });
    expect(buildLoggingMessageRedactedSummary(0)).toStrictEqual({ payload: 0 });
    expect(buildLoggingMessageRedactedSummary('')).toStrictEqual({
      payload: { type: 'string', length: 0 },
    });
  });
});

describe('writeLoggingMessagePayloadToR2', () => {
  function bucket() {
    const put = vi.fn(async (_key: string, _value: string, _options?: unknown) => undefined);
    return { put, bucket: { put } };
  }
  const input = {
    jobId: 'lmj_1',
    payloadType: 'export_build',
    schemaVersion: 3,
    lane: 'bulk',
    criticality: 'critical',
    sourceType: 'payload_object',
    tenantKey: 't_1',
    now: Date.UTC(2026, 0, 2, 3),
  } as const;

  it('stores stable JSON with its hash and returns the layout of what it stored', async () => {
    const { put, bucket: target } = bucket();
    const payload = { z: [3, { b: 1, a: 2 }], a: 'é', secret: 'hidden' };
    const result = await writeLoggingMessagePayloadToR2({ ...input, bucket: target, payload });
    const json = '{"a":"é","secret":"hidden","z":[3,{"a":2,"b":1}]}';
    const hash = await sha256Hex(json);
    expect(result).toStrictEqual({
      objectRef: buildLoggingMessagePayloadKey(input),
      sha256: hash,
      byteLength: new TextEncoder().encode(json).byteLength,
      redactedSummary: {
        a: { type: 'string', length: 1 },
        secret: '[redacted]',
        z: { type: 'array', length: 2 },
      },
      validationSummary: {
        payload_type: 'export_build',
        schema_version: 3,
        sha256: hash,
        byte_length: new TextEncoder().encode(json).byteLength,
      },
    });
    expect(result.byteLength).toBeGreaterThan(json.length);
    expect(put).toHaveBeenCalledWith(result.objectRef, json, {
      httpMetadata: { contentType: 'application/json' },
      customMetadata: {
        payload_type: 'export_build',
        schema_version: '3',
        sha256: hash,
        message_job_id: 'lmj_1',
      },
    });
  });

  it('serialises scalars and null as they are', async () => {
    for (const [payload, json] of [
      [null, 'null'],
      ['x', '"x"'],
      [5, '5'],
      [[1, 'a'], '[1,"a"]'],
    ] as const) {
      const { put, bucket: target } = bucket();
      await writeLoggingMessagePayloadToR2({ ...input, bucket: target, payload });
      expect(put.mock.calls[0]?.[1]).toBe(json);
    }
  });

  it('lets an encoder replace the body, content type and add metadata', async () => {
    const { put, bucket: target } = bucket();
    const encoder = vi.fn(
      async (call: { plaintext: string; objectRef: string; sha256: string }) => ({
        body: `enc:${call.plaintext}`,
        contentType: 'application/octet-stream',
        customMetadata: { encrypted: 'yes', payload_type: 'overridden' },
      })
    );
    const result = await writeLoggingMessagePayloadToR2({
      ...input,
      bucket: target,
      payload: { a: 1 },
      storedPayloadEncoder: encoder,
    });
    expect(encoder).toHaveBeenCalledWith({
      plaintext: '{"a":1}',
      objectRef: result.objectRef,
      sha256: result.sha256,
    });
    expect(put).toHaveBeenCalledWith(result.objectRef, 'enc:{"a":1}', {
      httpMetadata: { contentType: 'application/octet-stream' },
      customMetadata: {
        payload_type: 'overridden',
        schema_version: '3',
        sha256: result.sha256,
        message_job_id: 'lmj_1',
        encrypted: 'yes',
      },
    });
    expect(result.byteLength).toBe(7);
  });

  it('keys the object at the given time, or now', async () => {
    const { bucket: target } = bucket();
    vi.useFakeTimers();
    vi.setSystemTime(new Date(Date.UTC(2031, 1, 3, 4)));
    const result = await writeLoggingMessagePayloadToR2({
      ...input,
      now: undefined,
      bucket: target,
      payload: {},
    });
    expect(result.objectRef).toContain('/yyyy=2031/mm=02/dd=03/hh=04/');
  });
});
