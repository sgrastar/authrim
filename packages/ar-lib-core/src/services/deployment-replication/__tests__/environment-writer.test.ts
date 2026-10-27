import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  parseReplicationWriterConfiguration,
  runReplicationWriterOperation,
  type EnvironmentReplicationWriterConfiguration,
} from '../writer';
const config: EnvironmentReplicationWriterConfiguration = {
  version: 2,
  endpoint: 'https://authority.example.test/replication/v1/rpc',
  credentialId: 'aws-writer',
  pairId: 'pair-a',
  environmentId: 'environment-a',
  deploymentId: 'aws-a',
  epoch: 2,
  generationId: 'group-a',
  tenantId: 'alpha',
  restoreId: 'restore-alpha',
};
afterEach(() => vi.unstubAllGlobals());
describe('environment writer configuration and admission', () => {
  it('keeps explicit environment and child identities distinct', () => {
    expect(parseReplicationWriterConfiguration(JSON.stringify(config))).toEqual(config);
    const { tenantId: _t, restoreId: _r, ...original } = config;
    expect(parseReplicationWriterConfiguration(JSON.stringify({ ...original, epoch: 1 }))).toEqual({
      ...original,
      epoch: 1,
    });
  });
  it.each([
    { ...config, version: 1 },
    { ...config, restoreId: undefined },
    { ...config, tenantId: undefined },
    { ...config, tenantId: 'bad/id' },
    { ...config, environmentId: undefined },
    { ...config, extra: 'ignored' },
  ])('rejects mixed/partial identity configuration %#', (value) => {
    expect(() => parseReplicationWriterConfiguration(JSON.stringify(value))).toThrow(
      'configuration_invalid'
    );
  });
  it('uses environment RPC actions and exact child permits before and after a successful write', async () => {
    const calls: { action: string; payload: Record<string, unknown> }[] = [];
    const effect = vi.fn(async () => 'written');
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_url: unknown, init: RequestInit) => {
        if (typeof init.body !== 'string') throw new Error('expected_json_body');
        const body = JSON.parse(init.body) as {
          action: string;
          payload: Record<string, unknown>;
        };
        calls.push(body);
        if (body.action === 'environmentEnter') {
          expect(effect).not.toHaveBeenCalled();
          return Response.json(body.payload);
        }
        return Response.json({ completed: true });
      })
    );
    expect(
      await runReplicationWriterOperation(
        {
          AUTHRIM_REPLICATION_WRITER: JSON.stringify(config),
          AUTHRIM_REPLICATION_WRITER_SECRET: 'a'.repeat(64),
        },
        effect
      )
    ).toBe('written');
    expect(calls.map((c) => c.action)).toEqual(['environmentEnter', 'environmentComplete']);
    expect(calls[0].payload).toEqual(calls[1].payload);
    expect(calls[0].payload).toMatchObject({
      environmentId: 'environment-a',
      tenantId: 'alpha',
      restoreId: 'restore-alpha',
      generationId: 'group-a',
    });
    expect(effect).toHaveBeenCalledOnce();
  });
  it('cannot execute when admission echoes the wrong restored child', async () => {
    const effect = vi.fn(async () => 'unsafe');
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_url: unknown, init: RequestInit) => {
        if (typeof init.body !== 'string') throw new Error('expected_json_body');
        const body = JSON.parse(init.body) as { payload: Record<string, unknown> };
        return Response.json({ ...body.payload, restoreId: 'other' });
      })
    );
    await expect(
      runReplicationWriterOperation(
        {
          AUTHRIM_REPLICATION_WRITER: JSON.stringify(config),
          AUTHRIM_REPLICATION_WRITER_SECRET: 'a'.repeat(64),
        },
        effect
      )
    ).rejects.toThrow('admission_invalid');
    expect(effect).not.toHaveBeenCalled();
  });
  it('retains the global permit after an unknown write outcome', async () => {
    const actions: string[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_url: unknown, init: RequestInit) => {
        if (typeof init.body !== 'string') throw new Error('expected_json_body');
        const body = JSON.parse(init.body) as {
          action: string;
          payload: Record<string, unknown>;
        };
        actions.push(body.action);
        return Response.json(body.payload);
      })
    );
    await expect(
      runReplicationWriterOperation(
        {
          AUTHRIM_REPLICATION_WRITER: JSON.stringify(config),
          AUTHRIM_REPLICATION_WRITER_SECRET: 'a'.repeat(64),
        },
        async () => {
          throw new Error('unknown write');
        }
      )
    ).rejects.toThrow('unknown write');
    expect(actions).toEqual(['environmentEnter']);
  });
});
