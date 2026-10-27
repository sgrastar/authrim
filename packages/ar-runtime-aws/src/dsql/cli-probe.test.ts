import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { runDsqlCli } from './cli';
import { runDsqlConfigurationProbe } from './configuration-probe';
import { runDsqlIdentityProbe } from './identity-probe';

const client = vi.hoisted(() => ({ close: vi.fn() }));
vi.mock('./adapter', () => ({
  AuroraDsqlAdapter: class {
    close = client.close;
  },
}));
vi.mock('./configuration-probe', () => ({ runDsqlConfigurationProbe: vi.fn() }));
vi.mock('./identity-probe', () => ({ runDsqlIdentityProbe: vi.fn() }));

let directory: string;
let config: string;
beforeEach(async () => {
  vi.clearAllMocks();
  client.close.mockResolvedValue(undefined);
  directory = await mkdtemp(join(tmpdir(), 'authrim-dsql-cli-probe-'));
  config = join(directory, 'connection.json');
  await writeFile(
    config,
    JSON.stringify({
      hostname: `${'a'.repeat(26)}.dsql.ap-northeast-1.on.aws`,
      region: 'ap-northeast-1',
      user: 'admin',
    })
  );
  vi.spyOn(process.stdout, 'write').mockReturnValue(true);
  vi.spyOn(process.stderr, 'write').mockReturnValue(true);
});
afterEach(async () => {
  vi.restoreAllMocks();
  await rm(directory, { recursive: true, force: true });
});

describe('native probe CLI dispatch', () => {
  it.each([undefined, '2000'])(
    'dispatches the real configuration entry point with count %s and closes the adapter',
    async (count) => {
      const stdout = vi.spyOn(process.stdout, 'write');
      const report = {
        formatVersion: 1 as const,
        mode: 'synthetic-native-configuration' as const,
        fullRuntimeReady: false as const,
        passed: true,
        schema: `authrim_dsql_configuration_${'a'.repeat(32)}`,
        checks: [],
        cleanup: 'complete' as const,
      };
      vi.mocked(runDsqlConfigurationProbe).mockResolvedValue(report);
      expect(
        await runDsqlCli([
          'configuration-probe',
          '--config',
          config,
          '--write-probe',
          ...(count ? ['--sps', count] : []),
        ])
      ).toBe(0);
      expect(runDsqlConfigurationProbe).toHaveBeenCalledWith(
        expect.objectContaining({ close: client.close }),
        { writeProbe: true, spCount: Number(count ?? 101) }
      );
      expect(runDsqlIdentityProbe).not.toHaveBeenCalled();
      expect(client.close).toHaveBeenCalledOnce();
      expect(JSON.parse(String(stdout.mock.calls[0][0]))).toEqual(report);
    }
  );

  it('retains the identity route and closes the adapter after an unexpected configuration error', async () => {
    const stderr = vi.spyOn(process.stderr, 'write');
    vi.mocked(runDsqlIdentityProbe).mockResolvedValue({
      formatVersion: 1,
      mode: 'synthetic-native-identity',
      fullRuntimeReady: false,
      passed: true,
      schema: `authrim_dsql_identity_${'b'.repeat(32)}`,
      checks: [],
      cleanup: 'complete',
    });
    expect(await runDsqlCli(['identity-probe', '--config', config, '--write-probe'])).toBe(0);
    expect(runDsqlIdentityProbe).toHaveBeenCalledWith(
      expect.objectContaining({ close: client.close }),
      { writeProbe: true, userCount: 201 }
    );
    vi.mocked(runDsqlConfigurationProbe).mockRejectedValue(new Error('private database detail'));
    expect(await runDsqlCli(['configuration-probe', '--config', config, '--write-probe'])).toBe(1);
    expect(client.close).toHaveBeenCalledTimes(2);
    expect(stderr.mock.calls.flat().join('')).not.toContain('private database detail');
  });
});
