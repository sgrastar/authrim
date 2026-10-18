/**
 * Router form body inspection limits
 *
 * The router looks for an `access_token` form field on Bearer-token canonical paths before
 * authentication, rate limiting and CSRF. These tests pin that the read is bounded by real
 * bytes (not by Content-Length), that an over-limit body is rejected rather than passed on,
 * and that ordinary form posts still reach the downstream worker byte for byte.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import app from '../index';

const DEFAULT_LIMIT = 256 * 1024;
const UPLOAD_PATH = '/api/admin/assets/login-ui';
const UPLOAD_LIMIT = 5 * 1024 * 1024;

type MockFetcher = {
  fetch: ReturnType<typeof vi.fn>;
};

// Downstream mock that records the body bytes and content type it was given.
const createRecordingFetcher = (
  name: string
): MockFetcher & {
  received: Array<{ bytes: Uint8Array; contentType: string | null }>;
} => {
  const received: Array<{ bytes: Uint8Array; contentType: string | null }> = [];
  return {
    received,
    fetch: vi.fn(async (request: Request) => {
      received.push({
        bytes: new Uint8Array(await request.arrayBuffer()),
        contentType: request.headers.get('Content-Type'),
      });
      return new Response(JSON.stringify({ worker: name }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    }),
  };
};

const createMockEnv = (overrides: Record<string, unknown> = {}) => ({
  OP_DISCOVERY: createRecordingFetcher('OP_DISCOVERY'),
  OP_AUTH: createRecordingFetcher('OP_AUTH'),
  OP_TOKEN: createRecordingFetcher('OP_TOKEN'),
  OP_USERINFO: createRecordingFetcher('OP_USERINFO'),
  OP_MANAGEMENT: createRecordingFetcher('OP_MANAGEMENT'),
  OP_CONTROL: createRecordingFetcher('OP_CONTROL'),
  OP_ASYNC: createRecordingFetcher('OP_ASYNC'),
  OP_SAML: createRecordingFetcher('OP_SAML'),
  EXTERNAL_IDP: createRecordingFetcher('EXTERNAL_IDP'),
  ...overrides,
});

type Env = ReturnType<typeof createMockEnv>;

const FORM = 'application/x-www-form-urlencoded';
const ADMIN_ORIGIN = 'https://admin.example.com';

/** The admin UI's multipart upload: same-origin to the Admin UI so router CSRF lets it through. */
function uploadRequest(body: string, contentType: string): Request {
  return new Request(`https://api.example.com${UPLOAD_PATH}`, {
    method: 'POST',
    headers: { 'Content-Type': contentType, Origin: ADMIN_ORIGIN },
    body,
  });
}

/** A urlencoded body of exactly `bytes` bytes that has no access_token field. */
function formBodyOfSize(bytes: number): string {
  const prefix = 'client_id=x&padding=';
  expect(bytes).toBeGreaterThan(prefix.length);
  return prefix + 'a'.repeat(bytes - prefix.length);
}

/** The check the router used before it was bounded: parse a clone with the request's own headers. */
async function legacyHasFormBearerToken(contentType: string, body: string): Promise<boolean> {
  const request = new Request('https://example.com/introspect', {
    method: 'POST',
    headers: { 'Content-Type': contentType },
    body,
  });
  try {
    return (await request.clone().formData()).has('access_token');
  } catch {
    return false;
  }
}

function postForm(path: string, body: BodyInit, headers: Record<string, string> = {}): Request {
  return new Request(`https://example.com${path}`, {
    method: 'POST',
    headers: { 'Content-Type': FORM, ...headers },
    body,
  });
}

/** A chunked body: a stream with no Content-Length that counts what the router pulls. */
function countingStream(totalBytes: number, chunkBytes = 16 * 1024) {
  const state = { pulledBytes: 0, cancelled: false };
  let sent = 0;
  const chunk = new Uint8Array(chunkBytes).fill(0x61);
  const stream = new ReadableStream<Uint8Array>(
    {
      pull(controller) {
        if (sent >= totalBytes) {
          controller.close();
          return;
        }
        const size = Math.min(chunkBytes, totalBytes - sent);
        sent += size;
        state.pulledBytes += size;
        controller.enqueue(size === chunkBytes ? chunk : chunk.slice(0, size));
      },
      cancel() {
        state.cancelled = true;
      },
    },
    { highWaterMark: 0 }
  );
  return { stream, state };
}

function chunkedPost(path: string, stream: ReadableStream<Uint8Array>, contentType = FORM) {
  return new Request(`https://example.com${path}`, {
    method: 'POST',
    headers: { 'Content-Type': contentType },
    body: stream,
    duplex: 'half',
  } as RequestInit & { duplex: 'half' });
}

async function expectTooLarge(res: Response) {
  expect(res.status).toBe(413);
  expect(res.headers.get('Cache-Control')).toBe('no-store');
  expect(res.headers.get('Pragma')).toBe('no-cache');
  expect(res.headers.get('Content-Type')).toContain('application/json');
  const body = (await res.json()) as {
    error: string;
    error_description: string;
    error_details?: { code?: string };
  };
  expect(body.error).toBe('invalid_request');
  expect(typeof body.error_description).toBe('string');
  expect(body.error_details?.code).toBe('request_body_too_large');
}

function multipartBody(
  fields: Array<{ name: string; value: string; filename?: string; type?: string }>
) {
  const boundary = '----authrimtestboundary';
  const parts = fields.map(({ name, value, filename, type }) => {
    const disposition = filename
      ? `Content-Disposition: form-data; name="${name}"; filename="${filename}"\r\nContent-Type: ${type ?? 'application/octet-stream'}`
      : `Content-Disposition: form-data; name="${name}"`;
    return `--${boundary}\r\n${disposition}\r\n\r\n${value}\r\n`;
  });
  return {
    contentType: `multipart/form-data; boundary=${boundary}`,
    body: `${parts.join('')}--${boundary}--\r\n`,
  };
}

describe('Router form body inspection limit', () => {
  let env: Env;
  let originalCaches: unknown;

  beforeEach(() => {
    vi.clearAllMocks();
    originalCaches = (globalThis as { caches?: unknown }).caches;
    delete (globalThis as { caches?: unknown }).caches;
    env = createMockEnv({ ALLOWED_ORIGINS: ADMIN_ORIGIN });
  });

  afterEach(() => {
    vi.restoreAllMocks();
    if (originalCaches === undefined) {
      delete (globalThis as { caches?: unknown }).caches;
    } else {
      (globalThis as { caches?: unknown }).caches = originalCaches;
    }
  });

  describe('application/x-www-form-urlencoded', () => {
    it('forwards a body of exactly the limit with its bytes intact', async () => {
      const body = formBodyOfSize(DEFAULT_LIMIT);
      const res = await app.fetch(postForm('/token', body), env);

      expect(res.status).toBe(200);
      expect(env.OP_TOKEN.received).toHaveLength(1);
      expect(new TextDecoder().decode(env.OP_TOKEN.received[0].bytes)).toBe(body);
    });

    it('rejects a body one byte over the limit with 413 and does not forward it', async () => {
      const res = await app.fetch(postForm('/token', formBodyOfSize(DEFAULT_LIMIT + 1)), env);

      await expectTooLarge(res);
      expect(env.OP_TOKEN.fetch).not.toHaveBeenCalled();
    });

    it('rejects an over-limit body on chunked uploads and stops reading the stream', async () => {
      const total = 64 * 1024 * 1024;
      const { stream, state } = countingStream(total);
      const res = await app.fetch(chunkedPost('/token', stream), env);

      await expectTooLarge(res);
      expect(env.OP_TOKEN.fetch).not.toHaveBeenCalled();
      expect(state.cancelled).toBe(true);
      // Pulled far less than the 64 MiB offered: the limit plus at most a few chunks of slack.
      expect(state.pulledBytes).toBeLessThanOrEqual(DEFAULT_LIMIT + 4 * 16 * 1024);
    });

    it('rejects a body with no Content-Length whose first field is the padding', async () => {
      // client_id=x&padding=<huge>, the shape of the unauthenticated resource-exhaustion request.
      const encoder = new TextEncoder();
      let sent = 0;
      let cancelled = false;
      const stream = new ReadableStream<Uint8Array>(
        {
          pull(controller) {
            if (sent === 0) {
              controller.enqueue(encoder.encode('client_id=x&padding='));
            } else {
              controller.enqueue(new Uint8Array(32 * 1024).fill(0x62));
            }
            sent += 1;
          },
          cancel() {
            cancelled = true;
          },
        },
        { highWaterMark: 0 }
      );
      const req = chunkedPost('/par', stream);
      expect(req.headers.get('Content-Length')).toBeNull();

      const res = await app.fetch(req, env);

      await expectTooLarge(res);
      expect(cancelled).toBe(true);
      expect(sent).toBeLessThan(20);
    });

    it('rejects an over-limit Content-Length without reading the body', async () => {
      const { stream, state } = countingStream(1024);
      const req = chunkedPost('/token', stream);
      req.headers.set('Content-Length', String(DEFAULT_LIMIT + 1));

      const res = await app.fetch(req, env);

      await expectTooLarge(res);
      // Wrapping the request earlier in the router can prefetch one chunk; the 1 KiB body is
      // never read through, and the rejection does not wait for it.
      expect(state.pulledBytes).toBeLessThanOrEqual(16 * 1024);
      expect(state.cancelled).toBe(true);
      expect(env.OP_TOKEN.fetch).not.toHaveBeenCalled();
    });

    it('counts real bytes when Content-Length understates the body', async () => {
      const { stream, state } = countingStream(8 * 1024 * 1024);
      const req = chunkedPost('/token', stream);
      req.headers.set('Content-Length', '20');

      const res = await app.fetch(req, env);

      await expectTooLarge(res);
      expect(state.cancelled).toBe(true);
      expect(state.pulledBytes).toBeLessThanOrEqual(DEFAULT_LIMIT + 4 * 16 * 1024);
    });

    it('still rejects a small form that carries access_token', async () => {
      const res = await app.fetch(postForm('/userinfo', 'access_token=leaked-token'), env);
      const body = (await res.json()) as { error: string; error_details?: { code?: string } };

      expect(res.status).toBe(400);
      expect(body.error).toBe('invalid_request');
      expect(body.error_details?.code).toBe('bearer_token_transport_unsupported');
      expect(env.OP_USERINFO.fetch).not.toHaveBeenCalled();
    });

    it.each([
      ['after other fields', 'client_id=x&access_token=leaked'],
      ['percent-encoded name', 'client_id=x&access%5Ftoken=leaked'],
      ['empty value', 'access_token='],
      [
        'at the limit',
        `${formBodyOfSize(DEFAULT_LIMIT - 20)}&access_token=t`.slice(0, DEFAULT_LIMIT),
      ],
    ])('rejects access_token (%s)', async (_label, body) => {
      const res = await app.fetch(postForm('/introspect', body), env);

      expect(res.status).toBe(400);
      expect(env.OP_MANAGEMENT.fetch).not.toHaveBeenCalled();
    });

    it.each([
      ['a leading BOM', '\uFEFFaccess_token=x&client_id=y'],
      ['different case', 'Access_Token=x'],
      ['a semicolon separator', 'client_id=y;access_token=x'],
      ['plus-encoded name', 'access+token=x'],
      ['a NUL-suffixed name', 'access_token%00=x'],
      ['a repeated field', 'access_token=a&access_token=b'],
      ['an encoded first letter', '%61ccess_token=x'],
    ])('agrees with the previous clone().formData() check on %s', async (_label, body) => {
      const res = await app.fetch(postForm('/introspect', body), env);

      expect(res.status).toBe((await legacyHasFormBearerToken(FORM, body)) ? 400 : 200);
    });

    it('does not mistake a field that merely contains the name for access_token', async () => {
      const res = await app.fetch(
        postForm('/revoke', 'token=abc&x_access_token=1&access_token_hint=2'),
        env
      );

      expect(res.status).toBe(200);
      expect(env.OP_MANAGEMENT.received).toHaveLength(1);
    });

    it('inspects regardless of Content-Type case and parameters', async () => {
      const req = postForm('/userinfo', 'access_token=leaked', {
        'Content-Type': 'Application/X-WWW-Form-Urlencoded; charset=UTF-8',
      });
      const res = await app.fetch(req, env);

      expect(res.status).toBe(400);
    });

    it('bounds the declared-type check too: an over-limit body with a charset parameter', async () => {
      const req = postForm('/token', formBodyOfSize(DEFAULT_LIMIT + 1), {
        'Content-Type': 'application/x-www-form-urlencoded; charset=utf-8',
      });
      await expectTooLarge(await app.fetch(req, env));
    });

    it.each([
      ['/token', 'OP_TOKEN'],
      ['/par', 'OP_AUTH'],
      ['/register', 'OP_MANAGEMENT'],
      ['/device_authorization', 'OP_ASYNC'],
      ['/bc-authorize', 'OP_ASYNC'],
      ['/revoke', 'OP_MANAGEMENT'],
      ['/introspect', 'OP_MANAGEMENT'],
    ] as const)(
      'forwards an ordinary form post to %s with the exact body bytes',
      async (path, binding) => {
        // A private_key_jwt style post: a few KB assertion, non-ASCII and reserved characters.
        const assertion = `${'e'.repeat(1500)}.${'p'.repeat(2500)}.${'s'.repeat(700)}`;
        const body = new URLSearchParams({
          grant_type: 'client_credentials',
          client_id: 'client-1',
          client_assertion_type: 'urn:ietf:params:oauth:client-assertion-type:jwt-bearer',
          client_assertion: assertion,
          scope: 'openid profile',
          note: 'café 日本語 &=+%',
        }).toString();

        const res = await app.fetch(postForm(path, body), env);

        expect(res.status).toBe(200);
        const fetcher = env[binding];
        expect(fetcher.received).toHaveLength(1);
        expect(new TextDecoder().decode(fetcher.received[0].bytes)).toBe(body);
        expect(fetcher.received[0].contentType).toBe(FORM);
      }
    );

    it('forwards a chunked ordinary form post whole', async () => {
      const body = 'client_id=x&scope=openid';
      const encoder = new TextEncoder();
      const pieces = [body.slice(0, 7), body.slice(7, 15), body.slice(15)];
      const stream = new ReadableStream<Uint8Array>({
        start(controller) {
          for (const piece of pieces) controller.enqueue(encoder.encode(piece));
          controller.close();
        },
      });

      const res = await app.fetch(chunkedPost('/token', stream), env);

      expect(res.status).toBe(200);
      expect(new TextDecoder().decode(env.OP_TOKEN.received[0].bytes)).toBe(body);
    });

    it('forwards non-UTF-8 bytes unchanged', async () => {
      const bytes = new Uint8Array([
        ...new TextEncoder().encode('client_id=x&blob='),
        0xff,
        0xfe,
        0x00,
        0x41,
      ]);
      const res = await app.fetch(postForm('/token', bytes), env);

      expect(res.status).toBe(200);
      expect(Array.from(env.OP_TOKEN.received[0].bytes)).toEqual(Array.from(bytes));
    });

    it('forwards an empty form body', async () => {
      const res = await app.fetch(postForm('/token', ''), env);

      expect(res.status).toBe(200);
      expect(env.OP_TOKEN.received[0].bytes).toHaveLength(0);
    });
  });

  describe('Content-Type interpretation', () => {
    const MULTIPART_WITH_TOKEN =
      '--b\r\nContent-Disposition: form-data; name="access_token"\r\n\r\nleaked\r\n--b--\r\n';
    const MULTIPART_WITHOUT_TOKEN =
      '--b\r\nContent-Disposition: form-data; name="client_id"\r\n\r\nx\r\n--b--\r\n';
    const bodies = [
      ['multipart with access_token', MULTIPART_WITH_TOKEN],
      ['multipart without access_token', MULTIPART_WITHOUT_TOKEN],
      ['urlencoded with access_token', 'client_id=x&access_token=leaked'],
      ['urlencoded without access_token', 'client_id=x&scope=openid'],
    ] as const;
    const contentTypes = [
      'multipart/form-data; boundary=b; x=application/x-www-form-urlencoded',
      'multipart/form-data; x=application/x-www-form-urlencoded; boundary=b',
      'multipart/form-data; boundary="b"; x="application/x-www-form-urlencoded"',
      'multipart/form-data; x=a; y=b; boundary=b; z=application/x-www-form-urlencoded',
      'MULTIPART/Form-Data; Boundary=b',
      'Multipart/Form-Data; boundary=b; x=APPLICATION/X-WWW-FORM-URLENCODED',
      ' multipart/form-data ; boundary=b',
      'application/x-www-form-urlencoded; x=multipart/form-data',
      'application/x-www-form-urlencoded; x=multipart/form-data; boundary=b',
      'APPLICATION/X-WWW-FORM-URLENCODED; CHARSET=UTF-8',
      ' application/x-www-form-urlencoded ;charset=utf-8',
      'text/plain; x=application/x-www-form-urlencoded',
      'text/plain; boundary=b; x=multipart/form-data',
      'application/json; x=multipart/form-data',
    ];

    it.each([
      'multipart/form-data; boundary=b; x=application/x-www-form-urlencoded',
      'multipart/form-data; boundary="b"; x="application/x-www-form-urlencoded"',
      'Multipart/Form-Data; boundary=b; x=APPLICATION/X-WWW-FORM-URLENCODED',
    ])('rejects a multipart access_token whose Content-Type is %s', async (contentType) => {
      const res = await app.fetch(
        postForm('/introspect', MULTIPART_WITH_TOKEN, { 'Content-Type': contentType }),
        env
      );
      const body = (await res.json()) as { error: string; error_details?: { code?: string } };

      expect(res.status).toBe(400);
      expect(body.error_details?.code).toBe('bearer_token_transport_unsupported');
      expect(env.OP_MANAGEMENT.fetch).not.toHaveBeenCalled();
    });

    it('rejects a urlencoded access_token whose Content-Type carries a multipart parameter', async () => {
      const res = await app.fetch(
        postForm('/introspect', 'client_id=x&access_token=leaked', {
          'Content-Type': 'application/x-www-form-urlencoded; x=multipart/form-data',
        }),
        env
      );
      const body = (await res.json()) as { error_details?: { code?: string } };

      expect(res.status).toBe(400);
      expect(body.error_details?.code).toBe('bearer_token_transport_unsupported');
      expect(env.OP_MANAGEMENT.fetch).not.toHaveBeenCalled();
    });

    const matrix = contentTypes.flatMap((contentType) =>
      bodies.map(([label, body]) => [contentType, label, body] as const)
    );

    it.each(matrix)(
      'reaches the same verdict as the previous clone().formData() check: %s / %s',
      async (contentType, _label, body) => {
        const expected = await legacyHasFormBearerToken(contentType, body);

        const res = await app.fetch(
          postForm('/introspect', body, { 'Content-Type': contentType }),
          env
        );

        expect(res.status).toBe(expected ? 400 : 200);
        if (!expected) {
          expect(new TextDecoder().decode(env.OP_MANAGEMENT.received[0].bytes)).toBe(body);
          expect(env.OP_MANAGEMENT.received[0].contentType).toBe(contentType.trim());
        }
      }
    );

    it('the matrix contains both rejected and forwarded verdicts', async () => {
      const verdicts = await Promise.all(
        matrix.map(([contentType, , body]) => legacyHasFormBearerToken(contentType, body))
      );

      expect(verdicts).toContain(true);
      expect(verdicts).toContain(false);
    });
  });

  describe('multipart/form-data', () => {
    it('rejects a small multipart post carrying access_token', async () => {
      const { contentType, body } = multipartBody([
        { name: 'client_id', value: 'x' },
        { name: 'access_token', value: 'leaked' },
      ]);
      const res = await app.fetch(
        postForm('/userinfo', body, { 'Content-Type': contentType }),
        env
      );

      expect(res.status).toBe(400);
      expect(env.OP_USERINFO.fetch).not.toHaveBeenCalled();
    });

    it('forwards a multipart post without access_token with the exact body bytes', async () => {
      const { contentType, body } = multipartBody([
        { name: 'client_id', value: 'x' },
        { name: 'note', value: 'café' },
      ]);
      const res = await app.fetch(
        postForm('/register', body, { 'Content-Type': contentType }),
        env
      );

      expect(res.status).toBe(200);
      expect(new TextDecoder().decode(env.OP_MANAGEMENT.received[0].bytes)).toBe(body);
      expect(env.OP_MANAGEMENT.received[0].contentType).toBe(contentType);
    });

    it('rejects an over-limit multipart post on an ordinary path', async () => {
      const { contentType, body } = multipartBody([
        { name: 'padding', value: 'a'.repeat(DEFAULT_LIMIT) },
      ]);
      const res = await app.fetch(
        postForm('/register', body, { 'Content-Type': contentType }),
        env
      );

      await expectTooLarge(res);
      expect(env.OP_MANAGEMENT.fetch).not.toHaveBeenCalled();
    });

    it('cuts a chunked multipart stream at the limit', async () => {
      const { stream, state } = countingStream(32 * 1024 * 1024);
      const res = await app.fetch(
        chunkedPost('/token', stream, 'multipart/form-data; boundary=x'),
        env
      );

      await expectTooLarge(res);
      expect(state.cancelled).toBe(true);
      expect(state.pulledBytes).toBeLessThanOrEqual(DEFAULT_LIMIT + 4 * 16 * 1024);
    });

    it('accepts the Login UI asset upload above the ordinary limit', async () => {
      const { contentType, body } = multipartBody([
        { name: 'kind', value: 'logo' },
        { name: 'file', value: 'x'.repeat(1024 * 1024), filename: 'logo.png', type: 'image/png' },
      ]);
      const res = await app.fetch(uploadRequest(body, contentType), env);

      expect(res.status).toBe(200);
      expect(env.OP_MANAGEMENT.received).toHaveLength(1);
      expect(env.OP_MANAGEMENT.received[0].bytes.byteLength).toBe(
        new TextEncoder().encode(body).byteLength
      );
    });

    it('rejects a Login UI asset upload over its own limit', async () => {
      const { contentType, body } = multipartBody([
        { name: 'file', value: 'x'.repeat(UPLOAD_LIMIT), filename: 'logo.png', type: 'image/png' },
      ]);
      const res = await app.fetch(uploadRequest(body, contentType), env);

      await expectTooLarge(res);
      expect(env.OP_MANAGEMENT.fetch).not.toHaveBeenCalled();
    });

    it('rejects access_token in a Login UI asset upload', async () => {
      const { contentType, body } = multipartBody([
        { name: 'access_token', value: 'leaked' },
        { name: 'file', value: 'x'.repeat(1024), filename: 'logo.png', type: 'image/png' },
      ]);
      const res = await app.fetch(uploadRequest(body, contentType), env);

      expect(res.status).toBe(400);
      expect(env.OP_MANAGEMENT.fetch).not.toHaveBeenCalled();
    });

    it('leaves a malformed multipart body to the downstream parser', async () => {
      const res = await app.fetch(
        postForm('/register', 'not a multipart body', {
          'Content-Type': 'multipart/form-data; boundary=missing',
        }),
        env
      );

      expect(res.status).toBe(200);
      expect(env.OP_MANAGEMENT.received).toHaveLength(1);
    });
  });

  describe('configuration', () => {
    it('honours ROUTER_FORM_BODY_MAX_BYTES', async () => {
      env = createMockEnv({ ALLOWED_ORIGINS: ADMIN_ORIGIN, ROUTER_FORM_BODY_MAX_BYTES: '8192' });

      expect((await app.fetch(postForm('/token', formBodyOfSize(8192)), env)).status).toBe(200);
      await expectTooLarge(await app.fetch(postForm('/token', formBodyOfSize(8193)), env));
    });

    it('clamps a too-small setting to the 4 KiB floor', async () => {
      env = createMockEnv({ ALLOWED_ORIGINS: ADMIN_ORIGIN, ROUTER_FORM_BODY_MAX_BYTES: '1' });

      expect((await app.fetch(postForm('/token', formBodyOfSize(4096)), env)).status).toBe(200);
      await expectTooLarge(await app.fetch(postForm('/token', formBodyOfSize(4097)), env));
    });

    it('clamps a too-large setting to the 1 MiB ceiling', async () => {
      env = createMockEnv({
        ALLOWED_ORIGINS: ADMIN_ORIGIN,
        ROUTER_FORM_BODY_MAX_BYTES: String(1024 * 1024 * 1024),
      });

      expect((await app.fetch(postForm('/token', formBodyOfSize(1024 * 1024)), env)).status).toBe(
        200
      );
      await expectTooLarge(
        await app.fetch(postForm('/token', formBodyOfSize(1024 * 1024 + 1)), env)
      );
    });

    it.each(['', 'abc', 'NaN'])('falls back to the default for %j', async (value) => {
      env = createMockEnv({ ALLOWED_ORIGINS: ADMIN_ORIGIN, ROUTER_FORM_BODY_MAX_BYTES: value });

      expect((await app.fetch(postForm('/token', formBodyOfSize(DEFAULT_LIMIT)), env)).status).toBe(
        200
      );
      await expectTooLarge(
        await app.fetch(postForm('/token', formBodyOfSize(DEFAULT_LIMIT + 1)), env)
      );
    });

    it('does not let the setting change the asset upload limit', async () => {
      env = createMockEnv({ ALLOWED_ORIGINS: ADMIN_ORIGIN, ROUTER_FORM_BODY_MAX_BYTES: '4096' });
      const { contentType, body } = multipartBody([
        { name: 'file', value: 'x'.repeat(100 * 1024), filename: 'logo.png', type: 'image/png' },
      ]);
      const res = await app.fetch(uploadRequest(body, contentType), env);

      expect(res.status).toBe(200);
    });
  });

  describe('scope of the inspection', () => {
    it('still rejects the access_token query on GET', async () => {
      const res = await app.fetch(
        new Request('https://example.com/userinfo?access_token=leaked-token'),
        env
      );

      expect(res.status).toBe(400);
      expect(env.OP_USERINFO.fetch).not.toHaveBeenCalled();
    });

    it('forwards GET requests that have no body', async () => {
      const res = await app.fetch(new Request('https://example.com/userinfo'), env);

      expect(res.status).toBe(200);
    });

    it('does not inspect or limit non-canonical paths', async () => {
      const body = formBodyOfSize(DEFAULT_LIMIT * 4);
      const res = await app.fetch(postForm('/auth/external/oidf/callback', body), env);

      expect(res.status).toBe(200);
      expect(env.EXTERNAL_IDP.received).toHaveLength(1);
      expect(env.EXTERNAL_IDP.received[0].bytes.byteLength).toBe(body.length);
    });

    it('does not buffer or limit non-form content types on canonical paths', async () => {
      const json = JSON.stringify({ padding: 'a'.repeat(DEFAULT_LIMIT * 2) });
      const res = await app.fetch(
        postForm('/register', json, { 'Content-Type': 'application/json' }),
        env
      );

      expect(res.status).toBe(200);
      expect(env.OP_MANAGEMENT.received[0].bytes.byteLength).toBe(json.length);
    });
  });
});
