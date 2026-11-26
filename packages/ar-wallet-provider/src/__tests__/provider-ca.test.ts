import { execFileSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import {
  assertOutsideRepo,
  initCa,
  issueSignerSecret,
  MAX_LEAF_DAYS,
  readPin,
  writeSecretFile,
} from '../../scripts/provider-ca-lib';
import { createSecretSigner } from '../cloudflare/secret-signer';

function hasOpenssl(): boolean {
  try {
    execFileSync('openssl', ['version']);
    return true;
  } catch {
    return false;
  }
}

const dirs: string[] = [];
afterAll(() => dirs.forEach((d) => rmSync(d, { recursive: true, force: true })));

describe.skipIf(!hasOpenssl())('software provider CA', () => {
  const dir = mkdtempSync(join(tmpdir(), 'provider-ca-'));
  dirs.push(dir);
  const ca = join(dir, 'ca');
  const pins = initCa({ dir: ca, label: 'test' });
  const now = () => Math.floor(Date.now() / 1000);

  it('creates distinct intermediates and keeps key files private', () => {
    expect(pins.walletIntermediateSha256).not.toBe(pins.keyIntermediateSha256);
    expect(readPin(ca, 'wallet')).toBe(pins.walletIntermediateSha256);
    expect(statSync(join(ca, 'root.key')).mode & 0o077).toBe(0);
  });

  it('refuses to overwrite an existing CA', () => {
    expect(() => initCa({ dir: ca, label: 'test' })).toThrow(/already exists/);
  });

  it('issues a leaf that the production signer loads and signs with', async () => {
    const wallet = issueSignerSecret({ dir: ca, purpose: 'wallet', days: 30 });
    const key = issueSignerSecret({ dir: ca, purpose: 'key', days: 30 });
    const signer = createSecretSigner({
      walletSecret: wallet.secret,
      keySecret: key.secret,
      walletIntermediateSha256: pins.walletIntermediateSha256,
      keyIntermediateSha256: pins.keyIntermediateSha256,
      now,
    });
    const health = await signer.health();
    expect(health.chainNotAfter.key).toBeGreaterThan(now() + 25 * 86400);
    expect(health.chainNotAfter.wallet).toBeGreaterThan(now() + 25 * 86400);
  });

  it('is refused when the pin belongs to the other purpose', async () => {
    const wallet = issueSignerSecret({ dir: ca, purpose: 'wallet', days: 30 });
    const signer = createSecretSigner({
      walletSecret: wallet.secret,
      keySecret: undefined,
      walletIntermediateSha256: pins.keyIntermediateSha256,
      keyIntermediateSha256: undefined,
      now,
    });
    expect((await signer.health()).chainNotAfter.wallet).toBe(0);
  });

  it('limits leaf validity to the design maximum', () => {
    expect(() =>
      issueSignerSecret({ dir: ca, purpose: 'wallet', days: MAX_LEAF_DAYS + 1 })
    ).toThrow(/days/);
  });

  it('refuses a CA directory that others can enter', () => {
    const open = join(dir, 'open');
    mkdirSync(open, { mode: 0o755 });
    chmodSync(open, 0o755);
    expect(() => initCa({ dir: open, label: 'test' })).toThrow(/mode 0700/);
  });

  it('refuses to overwrite an existing secret file and paths inside a git repo', () => {
    const file = join(dir, 'out.json');
    writeFileSync(file, 'x', { mode: 0o644 });
    expect(() => writeSecretFile(file, 'secret')).toThrow();
    expect(() => assertOutsideRepo(join(process.cwd(), 'signer.json'))).toThrow(/git repository/);
    expect(() => assertOutsideRepo(join(dir, 'nested', 'signer.json'))).not.toThrow();
  });
});
