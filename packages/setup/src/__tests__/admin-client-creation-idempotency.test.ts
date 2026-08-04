import { readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../../..');

const DIRECT_ADMIN_CLIENT_CREATORS = [
  'packages/setup/src/core/downstream-introspection-client.ts',
  'packages/setup/src/core/generated-admin-api-smoke.ts',
  'packages/setup/src/core/generated-approvals-smoke-client.ts',
  'packages/setup/src/core/generated-auth-flow-smoke.ts',
  'packages/setup/src/core/login-ui-client.ts',
  'scripts/control-plane/phase0c-mail-otp-live.ts',
  'scripts/control-plane/phase0c-totp-load-live.ts',
  'scripts/control-plane/phase0c-totp-smoke-live.ts',
  'test/remote-logging/smoke-remote-logging-output.ts',
] as const;

describe('direct Admin Client API creators', () => {
  it.each(DIRECT_ADMIN_CLIENT_CREATORS)('%s supplies an idempotency key', async (relativePath) => {
    const source = await readFile(resolve(REPO_ROOT, relativePath), 'utf8');
    const clientEndpointOffsets = Array.from(source.matchAll(/\/api\/admin\/clients/g), (match) =>
      Number(match.index)
    );
    const createSegments = clientEndpointOffsets
      .map((offset) => source.slice(offset, offset + 1_500))
      .filter((segment) => /method:\s*['"]POST['"]/u.test(segment));

    expect(createSegments.length).toBeGreaterThan(0);
    expect(
      createSegments.some(
        (segment) => /Idempotency-Key/u.test(segment) || /idempotencyKey:\s*[^,\n]+/u.test(segment)
      )
    ).toBe(true);
  });
});
