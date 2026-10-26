import { mkdtemp, mkdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { Command } from 'commander';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { registerAwsCommands, runAwsSetupCommand } from '../cli/commands/aws.js';

describe('AWS setup command', () => {
  let source: string;
  let scripts: string;
  const target = { accountId: '123456789012', region: 'ap-northeast-1' };

  beforeEach(async () => {
    source = await mkdtemp(join(tmpdir(), 'authrim-aws-command-'));
    scripts = join(source, 'packages/ar-runtime-aws/scripts');
    await mkdir(scripts, { recursive: true });
    await writeFile(join(scripts, 'aws-preflight.mjs'), '// test fixture only\n');
    await writeFile(join(scripts, 'setup-plan.mjs'), '// test fixture only\n');
  });

  afterEach(async () => {
    await rm(source, { recursive: true, force: true });
  });

  it('forwards explicit target and profile to the independent AWS preflight', async () => {
    const runScript = vi.fn().mockResolvedValue(0);
    const exit = await runAwsSetupCommand(
      'check',
      { ...target, source, profile: 'authrim-operator', phase: 'workload', json: true },
      { runScript }
    );
    expect(exit).toBe(0);
    expect(runScript).toHaveBeenCalledExactlyOnceWith(
      join(scripts, 'aws-preflight.mjs'),
      [
        '--account-id',
        target.accountId,
        '--region',
        target.region,
        '--phase',
        'workload',
        '--profile',
        'authrim-operator',
        '--json',
      ],
      source
    );
  });

  it('does not write a plan when the AWS preflight is blocked', async () => {
    const runScript = vi.fn().mockResolvedValue(1);
    const exit = await runAwsSetupCommand(
      'plan',
      { ...target, source, out: 'private/not-created.json' },
      { runScript }
    );
    expect(exit).toBe(1);
    expect(runScript).toHaveBeenCalledTimes(1);
    expect(runScript.mock.calls[0][0]).toBe(join(scripts, 'aws-preflight.mjs'));
  });

  it('checks the selected account before creating the local plan with the same target', async () => {
    const runScript = vi.fn().mockResolvedValueOnce(0).mockResolvedValueOnce(0);
    const exit = await runAwsSetupCommand(
      'plan',
      { ...target, source, out: 'private/plan.json', issuerHost: 'id.example.com' },
      { runScript }
    );
    expect(exit).toBe(0);
    expect(runScript).toHaveBeenCalledTimes(2);
    expect(runScript.mock.calls[0][1]).toContain('foundation');
    expect(runScript.mock.calls[1]).toEqual([
      join(scripts, 'setup-plan.mjs'),
      [
        'create',
        '--account-id',
        target.accountId,
        '--region',
        target.region,
        '--out',
        resolve('private/plan.json'),
        '--issuer-host',
        'id.example.com',
      ],
      source,
    ]);
  });

  it('retains plan command failure without claiming plan creation succeeded', async () => {
    const runScript = vi.fn().mockResolvedValueOnce(0).mockResolvedValueOnce(1);
    expect(
      await runAwsSetupCommand('plan', { ...target, source, out: 'existing.json' }, { runScript })
    ).toBe(1);
  });

  it('reports missing repository sources without trying AWS or exposing a filesystem error', async () => {
    await rm(join(scripts, 'aws-preflight.mjs'));
    const runScript = vi.fn();
    const reportError = vi.fn();
    expect(
      await runAwsSetupCommand(
        'check',
        { ...target, source, json: true },
        { runScript, reportError }
      )
    ).toBe(2);
    expect(runScript).not.toHaveBeenCalled();
    expect(JSON.parse(reportError.mock.calls[0][0])).toEqual({
      status: 'blocked',
      code: 'aws_setup_source_missing',
    });
  });

  it('rejects a script symlink before executing it', async () => {
    await rm(join(scripts, 'aws-preflight.mjs'));
    await symlink(join(scripts, 'setup-plan.mjs'), join(scripts, 'aws-preflight.mjs'));
    const runScript = vi.fn();
    expect(
      await runAwsSetupCommand('check', { ...target, source }, { runScript, reportError: vi.fn() })
    ).toBe(2);
    expect(runScript).not.toHaveBeenCalled();
  });

  it('redacts subprocess errors and does not continue to plan creation', async () => {
    const runScript = vi.fn().mockRejectedValue(new Error('private command output: secret-token'));
    const reportError = vi.fn();
    const exit = await runAwsSetupCommand(
      'plan',
      { ...target, source, out: 'private/plan.json', json: true },
      { runScript, reportError }
    );
    expect(exit).toBe(2);
    expect(runScript).toHaveBeenCalledTimes(1);
    expect(reportError.mock.calls[0][0]).not.toContain('secret-token');
    expect(JSON.parse(reportError.mock.calls[0][0]).code).toBe('aws_setup_process_failed');
  });

  it('registers explicit AWS subcommands without changing existing Cloudflare commands', () => {
    const program = new Command();
    const init = program.command('init').action(vi.fn());
    const deploy = program.command('deploy').action(vi.fn());
    registerAwsCommands(program);
    expect(program.commands.slice(0, 2)).toEqual([init, deploy]);
    const aws = program.commands.find((command) => command.name() === 'aws');
    expect(aws?.commands.map((command) => command.name())).toEqual(['check', 'plan']);
    const check = aws?.commands[0];
    expect(check?.options.find((option) => option.long === '--phase')?.argChoices).toEqual([
      'bootstrap',
      'foundation',
      'workload',
    ]);
  });
});
