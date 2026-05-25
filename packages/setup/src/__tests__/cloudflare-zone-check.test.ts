import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { execa } from 'execa';
import {
  checkZoneExists,
  type ZoneCheckDiagnosticCode,
  type ZoneCheckResult,
} from '../core/cloudflare.js';

vi.mock('execa', () => ({
  execa: vi.fn(),
}));

vi.mock('node:os', async () => {
  const actual = await vi.importActual<typeof import('node:os')>('node:os');
  return {
    ...actual,
    homedir: () => '/tmp/authrim-zone-check-tests',
    platform: () => 'linux',
  };
});

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

function expectDiagnostic(
  result: ZoneCheckResult,
  code: ZoneCheckDiagnosticCode,
  allowBinding: boolean
): void {
  expect(result.found).toBe(code === 'zone_found');
  expect(result.zoneName).toBe('example.com');
  expect(result.diagnostic?.code).toBe(code);
  expect(result.diagnostic?.allowBinding).toBe(allowBinding);
}

describe('checkZoneExists', () => {
  const fetchMock = vi.fn<typeof fetch>();
  const execaMock = vi.mocked(execa);
  const originalApiToken = process.env.CLOUDFLARE_API_TOKEN;

  beforeEach(() => {
    fetchMock.mockReset();
    execaMock.mockReset();
    vi.stubGlobal('fetch', fetchMock);
    delete process.env.CLOUDFLARE_API_TOKEN;
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    if (originalApiToken === undefined) {
      delete process.env.CLOUDFLARE_API_TOKEN;
    } else {
      process.env.CLOUDFLARE_API_TOKEN = originalApiToken;
    }
  });

  it('returns a success diagnostic when the zone exists', async () => {
    process.env.CLOUDFLARE_API_TOKEN = 'test-token';
    fetchMock.mockResolvedValueOnce(
      jsonResponse({
        success: true,
        result: [{ id: 'zone-1', name: 'example.com', status: 'active' }],
      })
    );

    const result = await checkZoneExists('auth.example.com');

    expectDiagnostic(result, 'zone_found', true);
    expect(result.zone).toEqual({ id: 'zone-1', name: 'example.com', status: 'active' });
  });

  it('returns zone_not_found when the API succeeds but no zone is visible', async () => {
    process.env.CLOUDFLARE_API_TOKEN = 'test-token';
    fetchMock.mockResolvedValueOnce(jsonResponse({ success: true, result: [] }));

    const result = await checkZoneExists('auth.example.com');

    expectDiagnostic(result, 'zone_not_found', false);
  });

  it('returns zone_read_forbidden when zone listing is forbidden', async () => {
    process.env.CLOUDFLARE_API_TOKEN = 'test-token';
    fetchMock.mockResolvedValueOnce(jsonResponse({ success: false }, 403));

    const result = await checkZoneExists('auth.example.com');

    expectDiagnostic(result, 'zone_read_forbidden', true);
    expect(result.error).toContain('zone:read');
  });

  it('returns api_error when the Cloudflare API responds with a server error', async () => {
    process.env.CLOUDFLARE_API_TOKEN = 'test-token';
    fetchMock.mockResolvedValueOnce(jsonResponse({ success: false }, 500));

    const result = await checkZoneExists('auth.example.com');

    expectDiagnostic(result, 'api_error', false);
  });

  it('returns network_error when fetch rejects', async () => {
    process.env.CLOUDFLARE_API_TOKEN = 'test-token';
    fetchMock.mockRejectedValueOnce(new Error('socket hang up'));

    const result = await checkZoneExists('auth.example.com');

    expectDiagnostic(result, 'network_error', false);
    expect(result.error).toContain('socket hang up');
  });

  it('returns not_logged_in when Cloudflare auth is missing', async () => {
    execaMock.mockResolvedValueOnce({
      exitCode: 0,
      stdout: 'Not logged in. Run `wrangler login`.',
      stderr: '',
    } as Awaited<ReturnType<typeof execa>>);

    const result = await checkZoneExists('auth.example.com');

    expectDiagnostic(result, 'not_logged_in', false);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('returns token_unavailable when login exists but no API token can be read', async () => {
    execaMock.mockResolvedValueOnce({
      exitCode: 0,
      stdout: 'You are logged in with an OAuth token, associated with the email test@example.com.',
      stderr: '',
    } as Awaited<ReturnType<typeof execa>>);

    const result = await checkZoneExists('auth.example.com');

    expectDiagnostic(result, 'token_unavailable', false);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
