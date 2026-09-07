import { execa } from 'execa';

export interface RunReleaseUpdateInput {
  env: string;
  cwd: string;
  databaseOnly?: boolean;
  onProgress?: (line: string) => void;
}

export interface RunReleaseUpdateResult {
  success: boolean;
  exitCode: number;
}

function setupCliInvocation(): { command: string; args: string[] } {
  const entry = process.argv[1];
  if (!entry) throw new Error('setup_cli_entry_unavailable');
  return {
    command: process.execPath,
    args: [...process.execArgv, entry],
  };
}

function stripTerminalFormatting(value: string): string {
  // The child process explicitly disables color; normalize carriage returns from spinner output.
  return value.replace(/\r/gu, '');
}

export async function runReleaseUpdateCli(
  input: RunReleaseUpdateInput
): Promise<RunReleaseUpdateResult> {
  const invocation = setupCliInvocation();
  const args = [...invocation.args, 'update', '--env', input.env, '--yes'];
  if (input.databaseOnly) args.push('--database-only');
  const subprocess = execa(invocation.command, args, {
    cwd: input.cwd,
    all: true,
    reject: false,
    env: { ...process.env, FORCE_COLOR: '0', NO_COLOR: '1' },
  });

  let buffered = '';
  const publish = (chunk: string): void => {
    buffered += stripTerminalFormatting(chunk);
    const lines = buffered.split('\n');
    buffered = lines.pop() ?? '';
    for (const line of lines) {
      const trimmed = line.trim();
      if (trimmed) input.onProgress?.(trimmed);
    }
  };
  subprocess.all?.on('data', (chunk: Buffer | string) => publish(String(chunk)));
  const result = await subprocess;
  const finalLine = buffered.trim();
  if (finalLine) input.onProgress?.(finalLine);
  return { success: result.exitCode === 0, exitCode: result.exitCode ?? 1 };
}
