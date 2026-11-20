import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const ENV_KEY = 'AUTHRIM_AWS_STATE_DATABASE_URL';

interface Harness {
  clientCtor: ReturnType<typeof vi.fn>;
  connect: ReturnType<typeof vi.fn>;
  end: ReturnType<typeof vi.fn>;
  count: ReturnType<typeof vi.fn>;
  repair: ReturnType<typeof vi.fn>;
  write: ReturnType<typeof vi.spyOn>;
}

async function run(
  args: string[],
  opts: {
    env?: string | undefined;
    before?: number;
    repaired?: { updated: number; remaining: number };
  } = {}
): Promise<{ h: Harness; error?: unknown }> {
  vi.resetModules();
  const connect = vi.fn(async () => undefined);
  const end = vi.fn(async () => undefined);
  const clientInstance = { connect, end };
  const clientCtor = vi.fn(function () {
    return clientInstance;
  });
  const count = vi.fn(async () => opts.before ?? 7);
  const repair = vi.fn(async () => opts.repaired ?? { updated: 7, remaining: 0 });
  vi.doMock('pg', () => ({ Client: clientCtor }));
  vi.doMock('./repair-audit-session-ids', () => ({
    countLegacyAuditSessionIds: count,
    repairLegacyAuditSessionIds: repair,
  }));
  process.argv = ['node', 'cli', ...args];
  if ('env' in opts) {
    if (opts.env === undefined) delete process.env[ENV_KEY];
    else process.env[ENV_KEY] = opts.env;
  } else {
    process.env[ENV_KEY] = 'postgres://example.invalid/db';
  }
  const write = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
  const h = { clientCtor, connect, end, count, repair, write } as unknown as Harness;
  try {
    await import('./repair-audit-session-ids-cli');
    return { h };
  } catch (error) {
    return { h, error };
  }
}

describe('repair-audit-session-ids-cli', () => {
  const origArgv = process.argv;
  const origEnv = process.env[ENV_KEY];

  beforeEach(() => {
    vi.restoreAllMocks();
  });
  afterEach(() => {
    process.argv = origArgv;
    if (origEnv === undefined) delete process.env[ENV_KEY];
    else process.env[ENV_KEY] = origEnv;
    vi.doUnmock('pg');
    vi.doUnmock('./repair-audit-session-ids');
    vi.restoreAllMocks();
  });

  it('rejects an unknown argument with the usage message before touching the database', async () => {
    const { h, error } = await run(['--dry']);
    expect((error as Error).message).toBe('usage: pnpm audit:repair-aws-session-ids [--apply]');
    expect(h.clientCtor).not.toHaveBeenCalled();
  });

  it('rejects split/duplicated apply arguments (joined with a single space)', async () => {
    const split = await run(['--app', 'ly']);
    expect((split.error as Error).message).toContain('usage:');
    const dup = await run(['--apply', '--apply']);
    expect((dup.error as Error).message).toContain('usage:');
  });

  it('requires the connection string with the exact message', async () => {
    const { h, error } = await run([], { env: undefined });
    expect((error as Error).message).toBe('AUTHRIM_AWS_STATE_DATABASE_URL is required');
    expect(h.clientCtor).not.toHaveBeenCalled();
    const empty = await run([], { env: '' });
    expect((empty.error as Error).message).toBe('AUTHRIM_AWS_STATE_DATABASE_URL is required');
  });

  it('dry run counts only, prints the count and closes the client', async () => {
    const { h, error } = await run([], { before: 5 });
    expect(error).toBeUndefined();
    expect(h.clientCtor).toHaveBeenCalledWith({
      connectionString: 'postgres://example.invalid/db',
      connectionTimeoutMillis: 10_000,
    });
    expect(h.connect).toHaveBeenCalledTimes(1);
    expect(h.count).toHaveBeenCalledTimes(1);
    expect(h.repair).not.toHaveBeenCalled();
    expect(h.write).toHaveBeenCalledTimes(1);
    expect(h.write).toHaveBeenCalledWith('Legacy session audit rows: 5\n');
    expect(h.end).toHaveBeenCalledTimes(1);
  });

  it('--apply repairs, prints before/updated/remaining and closes the client', async () => {
    const { h, error } = await run(['--apply'], {
      before: 9,
      repaired: { updated: 9, remaining: 0 },
    });
    expect(error).toBeUndefined();
    expect(h.repair).toHaveBeenCalledTimes(1);
    expect(h.write).toHaveBeenCalledWith(
      'Legacy session audit rows before: 9; updated: 9; remaining: 0\n'
    );
    expect(h.end).toHaveBeenCalledTimes(1);
  });

  it('--apply fails with aws_audit_repair_incomplete when rows remain, still closing the client', async () => {
    const { h, error } = await run(['--apply'], {
      before: 4,
      repaired: { updated: 1, remaining: 3 },
    });
    expect((error as Error).message).toBe('aws_audit_repair_incomplete');
    expect(h.write).toHaveBeenCalledWith(
      'Legacy session audit rows before: 4; updated: 1; remaining: 3\n'
    );
    expect(h.end).toHaveBeenCalledTimes(1);
  });
});
