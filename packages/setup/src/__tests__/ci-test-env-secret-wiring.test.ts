import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const repositoryRoot = resolve(import.meta.dirname, '../../../..');

describe('test environment Control Worker secret wiring', () => {
  it('maps dedicated GitHub secrets to the runtime child-token environment variables', () => {
    const workflow = readFileSync(
      resolve(repositoryRoot, '.github/workflows/deploy-test.yml'),
      'utf8'
    );

    expect(workflow).toContain(
      'CLOUDFLARE_D1_API_TOKEN: ${{ secrets.AUTHRIM_TEST_CLOUDFLARE_D1_API_TOKEN }}'
    );
    expect(workflow).toContain(
      'CLOUDFLARE_WORKERS_API_TOKEN: ${{ secrets.AUTHRIM_TEST_CLOUDFLARE_WORKERS_API_TOKEN }}'
    );
    expect(workflow).not.toContain('CLOUDFLARE_D1_API_TOKEN: ${{ secrets.CLOUDFLARE_API_TOKEN }}');
    expect(workflow).not.toContain(
      'CLOUDFLARE_WORKERS_API_TOKEN: ${{ secrets.CLOUDFLARE_API_TOKEN }}'
    );
    expect(workflow).not.toContain('WRANGLER_LOG:');
  });

  // This uploader is operator-local tooling, intentionally absent from public checkouts.
  it.runIf(existsSync(resolve(repositoryRoot, 'private/scripts/upload-test-env-secrets.sh')))(
    'keeps the two runtime child tokens out of the generated environment archive',
    () => {
      const uploader = readFileSync(
        resolve(repositoryRoot, 'private/scripts/upload-test-env-secrets.sh'),
        'utf8'
      );

      expect(uploader).toContain('D1_TOKEN_SECRET="AUTHRIM_${SECRET_ENV}_CLOUDFLARE_D1_API_TOKEN"');
      expect(uploader).toContain(
        'WORKERS_TOKEN_SECRET="AUTHRIM_${SECRET_ENV}_CLOUDFLARE_WORKERS_API_TOKEN"'
      );
      expect(uploader).toContain(
        'CONTROL_TOKEN_PAIR_READY_SECRET="AUTHRIM_${SECRET_ENV}_CONTROL_TOKEN_PAIR_READY"'
      );
      expect(uploader).toContain('Use distinct D1 and Workers tokens');
      expect(uploader.indexOf('gh secret delete "$CONTROL_TOKEN_PAIR_READY_SECRET"')).toBeLessThan(
        uploader.indexOf('gh secret set "$D1_TOKEN_SECRET"')
      );
      expect(uploader.indexOf('gh secret set "$WORKERS_TOKEN_SECRET"')).toBeLessThan(
        uploader.indexOf('gh secret set "$CONTROL_TOKEN_PAIR_READY_SECRET"')
      );
      expect(uploader).not.toMatch(/tar[^\n]+CLOUDFLARE_(?:D1|WORKERS)_API_TOKEN/);
    }
  );
});
