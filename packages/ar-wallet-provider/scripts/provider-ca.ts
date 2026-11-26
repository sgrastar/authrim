/**
 * Operator CLI for the provider signing chains (software CA, staging).
 *
 *   tsx scripts/provider-ca.ts init   --dir <ca-dir> --label staging
 *   tsx scripts/provider-ca.ts pins   --dir <ca-dir>
 *   tsx scripts/provider-ca.ts issue  --dir <ca-dir> --purpose wallet|key --days 30 --out <file>
 *   tsx scripts/provider-ca.ts put-secret --dir <ca-dir> --purpose wallet|key --days 30 --env staging
 *   tsx scripts/provider-ca.ts put-challenge-key --env staging
 *
 * `<ca-dir>` must be outside the repository. Secrets are written to files with mode 0600 or sent
 * to `wrangler secret put` on stdin; they are never printed.
 */
import { execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import {
  assertOutsideRepo,
  initCa,
  issueSignerSecret,
  MAX_LEAF_DAYS,
  readPin,
  writeSecretFile,
  type Purpose,
} from '../src/ca/provider-ca';

const out = (line: string): void => void process.stdout.write(`${line}\n`);

function flag(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 ? process.argv[i + 1] : undefined;
}

function need(name: string): string {
  const value = flag(name);
  if (!value) throw new Error(`--${name} is required`);
  return value;
}

function purposeOf(): Purpose {
  const p = need('purpose');
  if (p !== 'wallet' && p !== 'key') throw new Error('--purpose must be wallet or key');
  return p;
}

function days(): number {
  const n = Number(flag('days') ?? String(MAX_LEAF_DAYS));
  if (!Number.isInteger(n) || n < 1 || n > MAX_LEAF_DAYS) {
    throw new Error(`--days must be 1..${MAX_LEAF_DAYS}`);
  }
  return n;
}

function putSecret(name: string, value: string, env: string): void {
  if (env !== 'staging') throw new Error('only --env staging is allowed by this script');
  execFileSync('npx', ['wrangler', 'secret', 'put', name, '--env', env], {
    input: value,
    // Never let wrangler write request bodies (they carry the secret) to its debug logs.
    env: { ...process.env, WRANGLER_LOG_SANITIZE: 'true', WRANGLER_WRITE_LOGS: 'false' },
    stdio: ['pipe', 'ignore', 'inherit'],
  });
  out(`secret ${name} set for ${env}`);
}

const command = process.argv[2];
if (command === 'init') {
  const r = initCa({ dir: need('dir'), label: need('label') });
  out(`root sha256               ${r.rootSha256}`);
  out(`wallet intermediate sha256 ${r.walletIntermediateSha256}`);
  out(`key intermediate sha256    ${r.keyIntermediateSha256}`);
} else if (command === 'pins') {
  out(`WALLET_INTERMEDIATE_SHA256=${readPin(need('dir'), 'wallet')}`);
  out(`KEY_INTERMEDIATE_SHA256=${readPin(need('dir'), 'key')}`);
} else if (command === 'issue') {
  const r = issueSignerSecret({ dir: need('dir'), purpose: purposeOf(), days: days() });
  assertOutsideRepo(need('out'));
  writeSecretFile(need('out'), r.secret);
  out(`written ${need('out')} (mode 0600); intermediate sha256 ${r.intermediateSha256}`);
} else if (command === 'put-secret') {
  const purpose = purposeOf();
  const r = issueSignerSecret({ dir: need('dir'), purpose, days: days() });
  putSecret(
    purpose === 'wallet' ? 'WALLET_ATTESTATION_SIGNER' : 'KEY_ATTESTATION_SIGNER',
    r.secret,
    need('env')
  );
} else if (command === 'put-challenge-key') {
  putSecret('CHALLENGE_HMAC_KEY', randomBytes(32).toString('base64'), need('env'));
} else {
  out('commands: init | pins | issue | put-secret | put-challenge-key');
  process.exitCode = 1;
}
