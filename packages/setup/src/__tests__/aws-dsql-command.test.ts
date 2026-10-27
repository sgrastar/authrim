import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Command } from 'commander';
import { registerAwsCommands, runAwsDsqlCommand } from '../cli/commands/aws.js';

let source: string;
const options = {
  accountId: '123456789012',
  region: 'ap-northeast-1',
  profile: 'test-operator',
  config: 'connection.json',
};
beforeEach(async () => {
  source = await mkdtemp(join(tmpdir(), 'authrim-setup-dsql-command-'));
  await mkdir(join(source, 'packages/ar-runtime-aws/scripts'), { recursive: true });
  await writeFile(join(source, 'packages/ar-runtime-aws/scripts/setup-dsql.mjs'), '// fixture');
});
afterEach(async () => {
  await rm(source, { recursive: true, force: true });
});

describe('DSQL evaluation setup entry', () => {
  it('forwards only the selected check target to the fixed DSQL wrapper', async () => {
    const runScript = vi.fn().mockResolvedValue(0);
    expect(await runAwsDsqlCommand('check', { ...options, source }, { runScript })).toBe(0);
    expect(runScript).toHaveBeenCalledExactlyOnceWith(
      join(source, 'packages/ar-runtime-aws/scripts/setup-dsql.mjs'),
      [
        'check',
        '--account-id',
        options.accountId,
        '--region',
        options.region,
        '--profile',
        options.profile,
        '--config',
        resolve(options.config),
      ],
      source
    );
  });

  it('requires reviewed input and explicit writes before invoking verification', async () => {
    const runScript = vi.fn().mockResolvedValue(0);
    const review = {
      ...options,
      source,
      configSha256: 'a'.repeat(64),
      bundleSha256: 'b'.repeat(64),
      principalArn: 'arn:aws:iam::123456789012:role/test-operator',
      principalId: 'AROATESTPRINCIPAL12345',
    };
    expect(await runAwsDsqlCommand('verify', review, { runScript, reportError: vi.fn() })).toBe(2);
    expect(runScript).not.toHaveBeenCalled();
    expect(
      await runAwsDsqlCommand(
        'verify',
        { ...review, writeProbe: true, users: '1001' },
        { runScript }
      )
    ).toBe(0);
    expect(runScript.mock.calls[0][1]).toContain('--write-probe');
    expect(runScript.mock.calls[0][1]).toContain(review.configSha256);
    expect(runScript.mock.calls[0][1]).toContain(review.bundleSha256);
  });

  it('redacts source and subprocess errors', async () => {
    const reportError = vi.fn();
    expect(
      await runAwsDsqlCommand(
        'check',
        { ...options, source },
        {
          runScript: vi.fn().mockRejectedValue(new Error('secret-token')),
          reportError,
        }
      )
    ).toBe(2);
    expect(reportError.mock.calls[0][0]).not.toContain('secret-token');
  });

  it('registers evaluation independently of the PostgreSQL deployment commands', () => {
    const program = new Command();
    registerAwsCommands(program);
    const aws = program.commands.find((command) => command.name() === 'aws');
    const dsql = aws?.commands.find((command) => command.name() === 'dsql');
    expect(dsql?.commands.map((command) => command.name())).toEqual(['check', 'verify']);
    const verify = dsql?.commands.find((command) => command.name() === 'verify');
    expect(verify?.options.find((option) => option.long === '--write-probe')?.mandatory).toBe(true);
    expect(aws?.commands.some((command) => command.name() === 'apply')).toBe(true);
  });
});
