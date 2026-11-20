import { describe, expect, it, vi } from 'vitest';
import {
  DirectoryPasswordClient,
  DirectoryPasswordError,
  buildDirectoryPasswordCanonicalRequest,
  validateDirectoryPasswordVerifyResult,
} from '../directory-password';

const config = {
  endpoint: 'https://wordwarden.example.com',
  tenantId: 'tenant-a',
  connectorId: 'wwcon_1',
  keyId: 'kid',
  secret: 'secret',
  timeoutMs: 1000,
};
const input = { username: 'alice', password: 'pw', requestId: 'req_1', nonce: 'n1' };
const ids = { request_id: 'req_1', tenant_id: 'tenant-a', connector_id: 'wwcon_1' };

function validate(value: unknown, requestId = 'req_1') {
  return validateDirectoryPasswordVerifyResult(value, config, requestId);
}

function codeOf(fn: () => unknown): string | undefined {
  try {
    fn();
  } catch (error) {
    if (error instanceof DirectoryPasswordError) return error.details.code;
    return `non-directory-error:${(error as Error).name}`;
  }
  return undefined;
}

const fact = (over: Record<string, unknown> = {}) => ({
  id: 'g1',
  dn: 'cn=g1,dc=x',
  display: 'Group 1',
  source: 'ldap',
  depth: 0,
  ...over,
});

describe('DirectoryPasswordClient transport errors', () => {
  it('maps an aborted request to timeout using the configured timeout', async () => {
    const fetcher = vi.fn(
      (_url: RequestInfo | URL, init?: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () =>
            reject(new DOMException('aborted', 'AbortError'))
          );
        })
    );
    const client = new DirectoryPasswordClient({ ...config, timeoutMs: 5 }, fetcher);
    await expect(client.verifyPassword(input)).rejects.toMatchObject({
      details: { code: 'timeout', retryable: true, status: 0, requestId: 'req_1' },
    });
  });

  it('maps other fetch failures to fetch_error', async () => {
    const fetcher = vi.fn(async () => {
      throw new TypeError('down');
    });
    await expect(
      new DirectoryPasswordClient(config, fetcher).verifyPassword(input)
    ).rejects.toMatchObject({
      details: { code: 'fetch_error', retryable: true, status: 0, connectorId: 'wwcon_1' },
    });
    const named = vi.fn(async () => {
      const error = new Error('x');
      error.name = 'AbortError';
      throw error;
    });
    await expect(
      new DirectoryPasswordClient(config, named).verifyPassword(input)
    ).rejects.toMatchObject({ details: { code: 'fetch_error' } });
  });

  it('falls back to wordwarden_error with status-derived retryability', async () => {
    const run = async (status: number) => {
      const fetcher = vi.fn(async () => new Response('bad', { status }));
      try {
        await new DirectoryPasswordClient(config, fetcher).verifyPassword(input);
      } catch (error) {
        return (error as DirectoryPasswordError).details;
      }
      throw new Error('expected failure');
    };
    expect(await run(500)).toMatchObject({
      code: 'wordwarden_error',
      retryable: true,
      status: 500,
    });
    expect(await run(501)).toMatchObject({ retryable: true });
    expect(await run(499)).toMatchObject({ code: 'wordwarden_error', retryable: false });
  });

  it('rejects a 200 response that is not JSON', async () => {
    const fetcher = vi.fn(async () => new Response('nope', { status: 200 }));
    await expect(
      new DirectoryPasswordClient(config, fetcher).verifyPassword(input)
    ).rejects.toMatchObject({ details: { code: 'invalid_connector_response', status: 502 } });
  });
});

describe('buildDirectoryPasswordCanonicalRequest header checks', () => {
  const base = {
    method: 'POST',
    url: new URL('https://x.example/v1'),
    body: '{}',
    timestamp: 't',
    nonce: 'n',
  };
  it('throws when a signed header is missing', async () => {
    await expect(
      buildDirectoryPasswordCanonicalRequest({
        ...base,
        headers: new Headers(),
        signedHeaders: ['x-missing'],
      })
    ).rejects.toThrow('missing signed header x-missing');
  });
  it('throws when a signed header is whitespace only', async () => {
    await expect(
      buildDirectoryPasswordCanonicalRequest({
        ...base,
        headers: new Headers({ 'x-blank': ' \t ' }),
        signedHeaders: ['x-blank'],
      })
    ).rejects.toThrow(/signed header x-blank/);
  });
});

describe('validateDirectoryPasswordVerifyResult', () => {
  it.each([null, 'string', 42, [ids]])(
    'rejects non-object %j as invalid_connector_response',
    (v) => {
      expect(codeOf(() => validate(v))).toBe('invalid_connector_response');
    }
  );

  it('treats empty identifiers as missing', () => {
    expect(codeOf(() => validate({ ...ids, request_id: '', result: 'failure' }, ''))).toBe(
      'connector_response_mismatch'
    );
  });

  it('defaults directory_status to ok and rejects other statuses', () => {
    expect(validate({ ...ids, result: 'failure' })).toMatchObject({ directory_status: 'ok' });
    expect(validate({ ...ids, result: 'failure', directory_status: '' })).toMatchObject({
      directory_status: 'ok',
    });
    const error = (() => {
      try {
        validate({ ...ids, result: 'success', directory_status: 'degraded' });
      } catch (e) {
        return e as DirectoryPasswordError;
      }
    })();
    expect(error?.details).toEqual({
      requestId: 'req_1',
      tenantId: 'tenant-a',
      connectorId: 'wwcon_1',
      code: 'unexpected_directory_status',
      retryable: false,
      status: 502,
    });
  });

  it.each([
    [undefined],
    ['subject'],
    [[{ directory_id: 'd', username: 'u' }]],
    [{ directory_id: 'd' }],
    [{ username: 'u' }],
    [{ directory_id: '', username: 'u' }],
  ])('rejects success with invalid subject %j', (subject) => {
    expect(codeOf(() => validate({ ...ids, result: 'success', subject }))).toBe(
      'invalid_connector_response'
    );
  });

  it('defaults failure reason to the result value', () => {
    expect(validate({ ...ids, result: 'policy_required', reason: '' })).toMatchObject({
      reason: 'policy_required',
    });
  });

  it('normalizes attributes: keeps only string values and drops empty keys', () => {
    const result = validate({
      ...ids,
      result: 'success',
      subject: { directory_id: 'd', username: 'u' },
      attributes: { mail: ['a@x', 5, null, 'b@x'], empty: [], nums: [1, 2], scalar: 'x' },
    });
    expect(result).toMatchObject({ attributes: { mail: ['a@x', 'b@x'] } });
    expect(Object.keys((result as { attributes: object }).attributes)).toEqual(['mail']);
  });

  it('returns undefined attributes when nothing usable remains', () => {
    const result = validate({
      ...ids,
      result: 'success',
      subject: { directory_id: 'd', username: 'u' },
      attributes: { nums: [1] },
    });
    expect((result as { attributes?: unknown }).attributes).toBeUndefined();
  });

  it('normalizes group facts with depth bounds and truncation', () => {
    const result = validate({
      ...ids,
      result: 'success',
      subject: { directory_id: 'd', username: 'u' },
      group_facts: [
        null,
        'not-a-record',
        fact({
          id: 'i'.repeat(600),
          dn: 'd'.repeat(3000),
          display: 'x'.repeat(600),
          source: 's'.repeat(200),
          depth: 3,
        }),
        fact({ id: 'neg', depth: -1 }),
        fact({ id: 'zero', depth: 0 }),
        fact({ id: 'twenty', depth: 20 }),
        fact({ id: 'twentyone', depth: 21 }),
        fact({ id: 'frac', depth: 1.5 }),
        fact({ id: 'str', depth: '1' }),
        fact({ id: 'inf', depth: Infinity }),
        fact({ id: 'nodisplay', display: '' }),
      ],
    }) as unknown as { group_facts: Array<Record<string, unknown>> };
    expect(result.group_facts.map((f) => f.id)).toEqual(['i'.repeat(512), 'zero', 'twenty']);
    expect(result.group_facts[0]).toEqual({
      id: 'i'.repeat(512),
      dn: 'd'.repeat(2048),
      display: 'x'.repeat(512),
      source: 's'.repeat(128),
      depth: 3,
    });
    expect(result.group_facts[2].depth).toBe(20);
  });

  it('caps group facts at 1000 entries and drops an all-invalid list', () => {
    const many = Array.from({ length: 1005 }, (_, i) => fact({ id: `g${i}`, depth: 1 }));
    const capped = validate({
      ...ids,
      result: 'success',
      subject: { directory_id: 'd', username: 'u' },
      group_facts: many,
    }) as { group_facts: unknown[] };
    expect(capped.group_facts).toHaveLength(1000);

    const none = validate({
      ...ids,
      result: 'success',
      subject: { directory_id: 'd', username: 'u' },
      group_facts: [fact({ depth: -5 })],
    }) as { group_facts?: unknown };
    expect(none.group_facts).toBeUndefined();
  });
});
