import { describe, expect, it, vi } from 'vitest';
import { createAwsSetupApi } from '../web/aws-api.js';
import { AwsWebError } from '../web/aws-setup-runner.js';

const token = 'a'.repeat(32);
const origin = 'http://localhost:3456';
const runId = '1d91c4f5-d9b6-4f65-b2ad-c304861b1a13';
const planSha256 = 'b'.repeat(64);
function fixture() {
  const runner = {
    configure: vi.fn(async () => ({
      status: 'configured',
      database: 'postgresql',
      configPath: '/managed/config.json',
      configSha256: planSha256,
    })),
    check: vi.fn(async () => ({
      status: 'passed',
      checks: [],
      permissionsVerified: false,
      writeAuthorization: 'not_proven',
    })),
    plan: vi.fn(async () => ({
      runId,
      status: 'planning' as const,
      browserLoginVerified: false as const,
    })),
    dsqlCheck: vi.fn(async () => ({
      runId,
      status: 'planning' as const,
      browserLoginVerified: false as const,
    })),
    start: vi.fn(async () => ({
      runId,
      status: 'running' as const,
      browserLoginVerified: false as const,
    })),
    status: vi.fn(async () => ({
      runId,
      status: 'planned' as const,
      browserLoginVerified: false as const,
    })),
  };
  const api = createAwsSetupApi({ getToken: () => token, runner });
  const request = (
    path: string,
    value: unknown = {},
    headers: Record<string, string> = {},
    method = 'POST'
  ) =>
    api.request(`${origin}${path}`, {
      method,
      headers: {
        'Content-Type': 'application/json',
        'X-Session-Token': token,
        Origin: origin,
        ...headers,
      },
      ...(method === 'GET'
        ? {}
        : { body: typeof value === 'string' ? value : JSON.stringify(value) }),
    });
  return { runner, request, api };
}
describe('local AWS web API boundary', () => {
  it('requires the local session for configuration creation and accepts no chosen output path', async () => {
    const { request, runner } = fixture();
    expect(
      (await request('/configuration', { configuration: {} }, { 'X-Session-Token': '' })).status
    ).toBe(401);
    expect(
      (await request('/configuration', { configuration: {}, outputPath: '/tmp/overwrite' })).status
    ).toBe(400);
    expect(runner.configure).not.toHaveBeenCalled();
    const configuration = { database: 'aurora-dsql' };
    expect((await request('/configuration', { configuration })).status).toBe(201);
    expect(runner.configure).toHaveBeenCalledWith(configuration);
  });
  it.each([
    ['missing token', { 'X-Session-Token': '' }, 401],
    ['same character count non-ASCII token', { 'X-Session-Token': 'é'.repeat(32) }, 401],
    ['foreign origin', { Origin: 'https://foreign.example.test' }, 403],
    ['missing origin', { Origin: '' }, 403],
    ['different loopback port', { Origin: 'http://localhost:9999' }, 403],
  ])('rejects %s before invoking any runner', async (_name, headers, expected) => {
    const { request, runner } = fixture();
    const response = await request('/check', {}, headers as Record<string, string>);
    expect(response.status).toBe(expected);
    expect(runner.check).not.toHaveBeenCalled();
  });
  it('protects status and rejects GET, remote host, malformed and oversized JSON', async () => {
    const { request, api, runner } = fixture();
    expect((await request(`/operations/${runId}/status`, {}, {}, 'GET')).status).toBe(405);
    expect(
      (
        await api.request(`http://remote.example.test/operations/${runId}/status`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'X-Session-Token': token,
            Origin: 'http://remote.example.test',
          },
          body: '{}',
        })
      ).status
    ).toBe(403);
    expect((await request('/check', '{')).status).toBe(400);
    expect((await request('/check', ' '.repeat(16385))).status).toBe(413);
    expect((await request('/check', {}, { 'Content-Length': '16385' })).status).toBe(413);
    expect((await request('/check', {}, { 'Content-Type': 'text/plain' })).status).toBe(400);
    expect(runner.check).not.toHaveBeenCalled();
    expect(runner.status).not.toHaveBeenCalled();
  });
  it('does not let browser select executor, source or state paths', async () => {
    const { request, runner } = fixture();
    const input = {
      configPath: '/private/public-config.json',
      accountId: '123456789012',
      region: 'ap-northeast-1',
    };
    for (const key of ['statePath', 'sourceDir', 'script', 'planPath'])
      expect((await request('/plan', { ...input, [key]: '/untrusted' })).status).toBe(400);
    expect(runner.plan).not.toHaveBeenCalled();
    const response = await request('/plan', input);
    expect(response.status).toBe(202);
    expect(runner.plan).toHaveBeenCalledWith(input);
    expect(response.headers.get('Cache-Control')).toBe('no-store');
  });
  it('requires exact explicit action bodies; passes no browser supplied DSQL pins', async () => {
    const { request, runner } = fixture();
    expect(
      (await request(`/operations/${runId}/apply`, { planSha256, configPath: '/other' })).status
    ).toBe(400);
    expect(
      (await request(`/operations/${runId}/verify`, { planSha256, principalArn: 'override' }))
        .status
    ).toBe(400);
    expect(
      (await request(`/operations/${runId}/verify`, { planSha256, userCount: 2001 })).status
    ).toBe(400);
    expect(runner.start).not.toHaveBeenCalled();
    expect(
      (await request(`/operations/${runId}/verify`, { planSha256, userCount: 1001 })).status
    ).toBe(202);
    expect(runner.start).toHaveBeenCalledWith(runId, 'verify', planSha256, 1001);
    expect((await request(`/operations/${runId}/status`, {})).status).toBe(200);
    expect((await request(`/operations/${runId}/status`, { configPath: '/other' })).status).toBe(
      400
    );
  });
  it('returns stable codes, never thrown secrets or command output', async () => {
    const { request, runner } = fixture();
    runner.status.mockRejectedValueOnce(new Error('password=PRIVATE_SENTINEL'));
    let response = await request(`/operations/${runId}/status`, {});
    expect(await response.json()).toEqual({
      success: false,
      status: 'blocked',
      code: 'aws_web_operation_failed',
    });
    runner.status.mockRejectedValueOnce(new AwsWebError('aws_web_operation_running'));
    response = await request(`/operations/${runId}/status`, {});
    expect(response.status).toBe(409);
  });
});
