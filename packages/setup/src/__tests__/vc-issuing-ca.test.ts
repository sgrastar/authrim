import { X509Certificate, createPrivateKey } from 'node:crypto';
import { existsSync, symlinkSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  base64ToBytes,
  buildCertificate,
  bytesToBase64,
  parseCertificate,
  validateVcSigningChain,
  verifyCertificateSignature,
} from '@authrim/ar-lib-core/vc/x509-certificate';
import { resolveVcCaKeysDir, runVcCaInit, VC_CA_FILES } from '../cli/commands/vc-ca-init.js';
import { loadDeploySecretsFromKeys } from '../core/deploy.js';
import { resolveLauncherPaths } from '../core/npm-launcher.js';
import {
  SECRET_KEY_FILES,
  SECRET_UPLOAD_PLAN,
  OPTIONAL_DEPLOY_SECRET_NAMES,
} from '../core/secrets.js';
import {
  certificatePemToDer,
  generateVcCa,
  mergeIssuingCaFingerprints,
  sha256Hex,
} from '../core/vc-issuing-ca.js';

const NOW = new Date('2026-11-23T00:00:00Z');
const DAY = 24 * 3_600_000;

describe('generateVcCa', () => {
  it('creates a root and an issuing CA that node:crypto agrees with', async () => {
    const material = await generateVcCa({ environment: 'prod', now: NOW });
    const root = new X509Certificate(material.rootCertificatePem);
    const issuing = new X509Certificate(
      Buffer.from(base64ToBytes(material.issuingCertificateBase64))
    );

    expect(root.ca).toBe(true);
    expect(issuing.ca).toBe(true);
    expect(root.subject).toContain('Authrim Root CA (prod)');
    expect(issuing.subject).toContain('Authrim Issuing CA (prod)');
    // The issuer name of the issuing CA is the root's subject, byte for byte.
    expect(issuing.issuer).toBe(root.subject);
    expect(root.verify(root.publicKey)).toBe(true);
    expect(issuing.verify(root.publicKey)).toBe(true);
    expect(issuing.checkIssued(root)).toBe(true);
    expect(root.checkIssued(root)).toBe(true);
  });

  it('gives the issuing CA pathLen 0 and the root pathLen 1, within their lifetimes', async () => {
    const material = await generateVcCa({ environment: 'prod', now: NOW });
    const issuing = parseCertificate(base64ToBytes(material.issuingCertificateBase64));
    const root = parseCertificate(certificatePemToDer(material.rootCertificatePem));
    expect(issuing.pathLength).toBe(0);
    expect(root.pathLength).toBe(1);
    expect(issuing.keyCertSign).toBe(true);
    expect(issuing.notAfter.getTime()).toBeLessThan(root.notAfter.getTime());
    expect(Math.round((issuing.notAfter.getTime() - NOW.getTime()) / DAY / 365)).toBe(5);
    expect(Math.round((root.notAfter.getTime() - NOW.getTime()) / DAY / 365)).toBe(20);
    expect(material.issuingNotAfter).toEqual(issuing.notAfter);
  });

  it('reports fingerprints of the DER and PEM keys that parse', async () => {
    const material = await generateVcCa({
      environment: 'staging',
      organization: 'Example Corp',
      now: NOW,
    });
    expect(material.issuingCertificateSha256).toBe(
      sha256Hex(base64ToBytes(material.issuingCertificateBase64))
    );
    expect(material.rootCertificateSha256).toBe(
      sha256Hex(certificatePemToDer(material.rootCertificatePem))
    );
    for (const pem of [material.issuingPrivateKeyPem, material.rootPrivateKeyPem ?? '']) {
      expect(pem.startsWith('-----BEGIN PRIVATE KEY-----')).toBe(true);
      const key = createPrivateKey(pem);
      expect(key.asymmetricKeyType).toBe('ec');
      expect(key.asymmetricKeyDetails?.namedCurve).toBe('prime256v1');
    }
    expect(new X509Certificate(material.rootCertificatePem).subject).toContain('Example Corp');
  });

  it('issues leaves the KeyManager profile accepts, signed with the generated issuing key', async () => {
    const material = await generateVcCa({ environment: 'prod', now: NOW });
    const issuingDer = base64ToBytes(material.issuingCertificateBase64);
    const issuing = parseCertificate(issuingDer);
    const issuingKey = await crypto.subtle.importKey(
      'pkcs8',
      certificateBodyOfKey(material.issuingPrivateKeyPem),
      { name: 'ECDSA', namedCurve: 'P-256' },
      false,
      ['sign']
    );
    const leafKeys = (await crypto.subtle.generateKey(
      { name: 'ECDSA', namedCurve: 'P-256' },
      true,
      ['sign', 'verify']
    )) as { publicKey: CryptoKey };
    const leafJwk = await crypto.subtle.exportKey('jwk', leafKeys.publicKey);
    const issuerPoint = issuing.publicPoint;
    const url = (b: Uint8Array) =>
      bytesToBase64(b).replace(/\+/gu, '-').replace(/\//gu, '_').replace(/=+$/u, '');
    const leaf = await buildCertificate(
      {
        subject: { commonName: 'issuer.example.com' },
        issuerNameDer: issuing.subjectName,
        subjectPublicKey: { kty: 'EC', crv: 'P-256', x: leafJwk.x, y: leafJwk.y },
        issuerPublicKey: {
          kty: 'EC',
          crv: 'P-256',
          x: url(issuerPoint.slice(1, 33)),
          y: url(issuerPoint.slice(33)),
        },
        notBefore: new Date(NOW.getTime() - 5 * 60_000),
        notAfter: new Date(NOW.getTime() + 90 * DAY),
        dnsNames: ['issuer.example.com'],
        isCA: false,
      },
      async (tbs) =>
        new Uint8Array(
          await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, issuingKey, tbs)
        )
    );
    expect(await verifyCertificateSignature(parseCertificate(leaf), issuing.publicPoint)).toBe(
      true
    );
    const info = await validateVcSigningChain(
      [bytesToBase64(leaf), material.issuingCertificateBase64],
      {
        publicKey: { kty: 'EC', crv: 'P-256', x: leafJwk.x, y: leafJwk.y },
        issuerHost: 'issuer.example.com',
        now: NOW.getTime(),
        expectedLength: 2,
        authrimProfile: true,
        trustedFinalCertificateSha256: [material.issuingCertificateSha256],
      }
    );
    expect(info.finalCertificateSha256).toBe(material.issuingCertificateSha256);
  });

  it('issues a new issuing CA under an existing root, and does not return a root key', async () => {
    const first = await generateVcCa({ environment: 'prod', now: NOW });
    const second = await generateVcCa({
      environment: 'prod',
      now: new Date(NOW.getTime() + 400 * DAY),
      root: {
        privateKeyPem: first.rootPrivateKeyPem ?? '',
        certificateDer: certificatePemToDer(first.rootCertificatePem),
      },
    });
    expect(second.rootPrivateKeyPem).toBeUndefined();
    expect(second.issuingCertificateSha256).not.toBe(first.issuingCertificateSha256);
    const root = new X509Certificate(first.rootCertificatePem);
    const issuing = new X509Certificate(
      Buffer.from(base64ToBytes(second.issuingCertificateBase64))
    );
    expect(issuing.verify(root.publicKey)).toBe(true);
    expect(second.rootCertificateSha256).toBe(first.rootCertificateSha256);
  });

  it('refuses a root key that is not the root certificate’s, an expired root and bad settings', async () => {
    const first = await generateVcCa({ environment: 'prod', now: NOW });
    const other = await generateVcCa({ environment: 'prod', now: NOW });
    const rootDer = certificatePemToDer(first.rootCertificatePem);
    await expect(
      generateVcCa({
        environment: 'prod',
        now: NOW,
        root: { privateKeyPem: other.rootPrivateKeyPem ?? '', certificateDer: rootDer },
      })
    ).rejects.toThrow('vc_ca_root_key_mismatch');
    await expect(
      generateVcCa({
        environment: 'prod',
        now: new Date(NOW.getTime() + 21 * 365 * DAY),
        root: { privateKeyPem: first.rootPrivateKeyPem ?? '', certificateDer: rootDer },
      })
    ).rejects.toThrow('vc_ca_root_not_valid_now');
    // A root with less than a month left cannot issue a useful issuing CA.
    await expect(
      generateVcCa({
        environment: 'prod',
        now: new Date(NOW.getTime() + 20 * 365 * DAY + 330 * DAY),
        root: { privateKeyPem: first.rootPrivateKeyPem ?? '', certificateDer: rootDer },
      })
    ).rejects.toThrow(/vc_ca_root_(not_valid_now|expires_too_soon)/u);
    await expect(generateVcCa({ environment: '', now: NOW })).rejects.toThrow(
      'vc_ca_environment_invalid'
    );
    await expect(generateVcCa({ environment: 'prod', now: NOW, rootYears: 50 })).rejects.toThrow(
      'vc_ca_lifetime_invalid'
    );
    await expect(generateVcCa({ environment: 'prod', now: NOW, issuingYears: 0 })).rejects.toThrow(
      'vc_ca_lifetime_invalid'
    );
  });

  it('never lets the issuing CA outlive the root', async () => {
    const material = await generateVcCa({
      environment: 'prod',
      now: NOW,
      rootYears: 2,
      issuingYears: 5,
    });
    expect(material.issuingNotAfter.getTime()).toBeLessThan(material.rootNotAfter.getTime());
  });
});

function certificateBodyOfKey(pem: string): Uint8Array {
  return base64ToBytes(
    pem
      .replace('-----BEGIN PRIVATE KEY-----', '')
      .replace('-----END PRIVATE KEY-----', '')
      .replace(/\s+/gu, '')
  );
}

describe('mergeIssuingCaFingerprints', () => {
  const a = 'a'.repeat(64);
  const b = 'b'.repeat(64);
  const c = 'c'.repeat(64);

  it('puts the new fingerprint first and keeps the previous ones', () => {
    expect(mergeIssuingCaFingerprints(a, undefined)).toBe(a);
    expect(mergeIssuingCaFingerprints(a, `${b},${c}\n`)).toBe(`${a},${b},${c}`);
    expect(mergeIssuingCaFingerprints(a, `${b},${a},${b}`)).toBe(`${a},${b}`);
  });

  it('drops malformed entries and folds case', () => {
    expect(mergeIssuingCaFingerprints(a, `nope,${b.toUpperCase()},,12`)).toBe(`${a},${b}`);
  });

  it('refuses, rather than silently dropping, when the list would exceed eight', () => {
    const seven = ['1', '2', '3', '4', '5', '6', '7'].map((digit) => digit.repeat(64));
    expect(mergeIssuingCaFingerprints(a, seven.join(',')).split(',')).toHaveLength(8);
    const eight = [...seven, '8'.repeat(64)];
    expect(() => mergeIssuingCaFingerprints(a, eight.join(','))).toThrow(
      'vc_ca_too_many_fingerprints'
    );
    // Re-adding one already present does not count twice.
    expect(mergeIssuingCaFingerprints(eight[0], eight.join(',')).split(',')).toHaveLength(8);
  });

  it('refuses a malformed new fingerprint', () => {
    expect(() => mergeIssuingCaFingerprints('xyz', undefined)).toThrow('vc_ca_fingerprint_invalid');
  });
});

describe('runVcCaInit', () => {
  let keysDir: string;

  beforeEach(async () => {
    keysDir = await mkdtemp(join(tmpdir(), 'authrim-vc-ca-'));
  });

  afterEach(async () => {
    await rm(keysDir, { recursive: true, force: true });
  });

  const file = (name: string) => join(keysDir, name);

  it('writes the issuing CA for deploy, the root certificate, and the root key apart', async () => {
    const result = await runVcCaInit({ env: 'prod', keysDir });
    expect(result.createdRoot).toBe(true);
    for (const name of Object.values(VC_CA_FILES)) expect(existsSync(file(name))).toBe(true);

    // Deploy uploads exactly these three, from the names the secret registry maps.
    expect(SECRET_KEY_FILES.VC_ISSUING_CA_PRIVATE_KEY_PEM).toBe(VC_CA_FILES.issuingPrivateKey);
    expect(SECRET_KEY_FILES.VC_ISSUING_CA_CERTIFICATE).toBe(VC_CA_FILES.issuingCertificate);
    expect(SECRET_KEY_FILES.VC_X5C_ISSUING_CA_SHA256).toBe(VC_CA_FILES.issuingFingerprints);

    // Private keys are readable by the owner only.
    for (const name of [VC_CA_FILES.issuingPrivateKey, VC_CA_FILES.rootPrivateKey]) {
      expect((await stat(file(name))).mode & 0o777).toBe(0o600);
    }
    const certificate = (await readFile(file(VC_CA_FILES.issuingCertificate), 'utf8')).trim();
    const fingerprints = (await readFile(file(VC_CA_FILES.issuingFingerprints), 'utf8')).trim();
    expect(fingerprints).toBe(sha256Hex(base64ToBytes(certificate)));
    expect(result.fingerprints).toBe(fingerprints);
    expect(await readFile(file(VC_CA_FILES.rootCertificate), 'utf8')).toContain(
      'BEGIN CERTIFICATE'
    );
  });

  it('writes nothing in a dry run', async () => {
    const result = await runVcCaInit({ env: 'prod', keysDir, dryRun: true });
    expect(result.written.length).toBeGreaterThan(0);
    for (const name of Object.values(VC_CA_FILES)) expect(existsSync(file(name))).toBe(false);
  });

  it('refuses to replace an existing issuing CA, and to do so without the root key', async () => {
    await runVcCaInit({ env: 'prod', keysDir });
    await expect(runVcCaInit({ env: 'prod', keysDir })).rejects.toThrow('vc_ca_exists');
    await expect(runVcCaInit({ env: 'prod', keysDir, force: true })).rejects.toThrow(
      'vc_ca_root_key_required'
    );
  });

  it('replaces the issuing CA under the same root, keeping the old one trusted and a backup', async () => {
    const first = await runVcCaInit({ env: 'prod', keysDir });
    const rootCertificate = await readFile(file(VC_CA_FILES.rootCertificate), 'utf8');
    const oldKey = await readFile(file(VC_CA_FILES.issuingPrivateKey), 'utf8');

    const second = await runVcCaInit({
      env: 'prod',
      keysDir,
      force: true,
      rootKey: file(VC_CA_FILES.rootPrivateKey),
    });
    expect(second.createdRoot).toBe(false);
    expect(second.rootKeyPath).toBeUndefined();
    expect(second.written.some((path) => path.endsWith(VC_CA_FILES.rootPrivateKey))).toBe(false);
    expect(second.fingerprints.split(',')).toEqual([
      second.material.issuingCertificateSha256,
      first.material.issuingCertificateSha256,
    ]);
    // The root is untouched and the replaced files are kept, under names never reused.
    expect(await readFile(file(VC_CA_FILES.rootCertificate), 'utf8')).toBe(rootCertificate);
    const keyBackup = second.backedUp.find((path) => path.includes(VC_CA_FILES.issuingPrivateKey));
    expect(keyBackup).toBeDefined();
    expect(await readFile(keyBackup ?? '', 'utf8')).toBe(oldKey);
    expect((await stat(keyBackup ?? '')).mode & 0o777).toBe(0o600);
    expect(await readFile(file(VC_CA_FILES.issuingPrivateKey), 'utf8')).not.toBe(oldKey);
    // The new issuing CA chains to the same root.
    const root = new X509Certificate(rootCertificate);
    const issuing = new X509Certificate(
      Buffer.from(
        base64ToBytes((await readFile(file(VC_CA_FILES.issuingCertificate), 'utf8')).trim())
      )
    );
    expect(issuing.verify(root.publicKey)).toBe(true);
  });

  it('reports missing root files and a wrong root key', async () => {
    await expect(runVcCaInit({ env: 'prod', keysDir, rootKey: file('nope.pem') })).rejects.toThrow(
      'vc_ca_root_files_not_found'
    );
    await runVcCaInit({ env: 'prod', keysDir });
    const stranger = await generateVcCa({ environment: 'prod', now: NOW });
    await writeFile(file('other-root.pem'), stranger.rootPrivateKeyPem ?? '');
    await expect(
      runVcCaInit({ env: 'prod', keysDir, force: true, rootKey: file('other-root.pem') })
    ).rejects.toThrow('vc_ca_root_key_mismatch');
  });

  it('refuses a root that is not the one this environment already trusts', async () => {
    await runVcCaInit({ env: 'prod', keysDir });
    // A valid root key and certificate pair, but of another environment.
    const staging = await generateVcCa({ environment: 'staging', now: NOW });
    await writeFile(file('staging-root.pem'), staging.rootPrivateKeyPem ?? '');
    await writeFile(file('staging-root-cert.pem'), staging.rootCertificatePem);
    const before = await readFile(file(VC_CA_FILES.issuingCertificate), 'utf8');
    await expect(
      runVcCaInit({
        env: 'prod',
        keysDir,
        force: true,
        rootKey: file('staging-root.pem'),
        rootCertificate: file('staging-root-cert.pem'),
      })
    ).rejects.toThrow('vc_ca_root_differs_from_saved');
    expect(await readFile(file(VC_CA_FILES.issuingCertificate), 'utf8')).toBe(before);
  });

  it('treats a partial set of CA files as an existing CA, not as an empty directory', async () => {
    await runVcCaInit({ env: 'prod', keysDir });
    const rootCertificate = await readFile(file(VC_CA_FILES.rootCertificate), 'utf8');
    // Only the issuing private key is lost (a partial restore).
    await rm(file(VC_CA_FILES.issuingPrivateKey));
    await expect(runVcCaInit({ env: 'prod', keysDir })).rejects.toThrow('vc_ca_exists');
    await expect(runVcCaInit({ env: 'prod', keysDir, force: true })).rejects.toThrow(
      'vc_ca_root_key_required'
    );
    expect(await readFile(file(VC_CA_FILES.rootCertificate), 'utf8')).toBe(rootCertificate);
    // Recovery is deliberate: the same root issues a new issuing CA.
    const recovered = await runVcCaInit({
      env: 'prod',
      keysDir,
      force: true,
      rootKey: file(VC_CA_FILES.rootPrivateKey),
    });
    expect(recovered.createdRoot).toBe(false);
    expect(existsSync(file(VC_CA_FILES.issuingPrivateKey))).toBe(true);
  });

  it('never writes the root key over a file deploy uploads or this command writes', async () => {
    for (const name of [
      VC_CA_FILES.issuingPrivateKey,
      VC_CA_FILES.issuingCertificate,
      VC_CA_FILES.issuingFingerprints,
      VC_CA_FILES.rootCertificate,
      'private.pem',
      'pii_encryption_key.txt',
    ]) {
      await expect(runVcCaInit({ env: 'prod', keysDir, rootKeyOut: file(name) })).rejects.toThrow(
        'vc_ca_root_key_out_reserved'
      );
    }
    // Nothing was written by the refused attempts.
    expect(existsSync(file(VC_CA_FILES.issuingPrivateKey))).toBe(false);
  });

  it('never overwrites an existing file or link at the root key output path', async () => {
    const outside = await mkdtemp(join(tmpdir(), 'authrim-out-'));
    try {
      const target = join(outside, 'offline-root.pem');
      await writeFile(target, 'precious');
      await expect(runVcCaInit({ env: 'prod', keysDir, rootKeyOut: target })).rejects.toThrow(
        'vc_ca_root_key_out_exists'
      );
      expect(await readFile(target, 'utf8')).toBe('precious');
      const link = join(outside, 'link-root.pem');
      symlinkSync(target, link);
      await expect(runVcCaInit({ env: 'prod', keysDir, rootKeyOut: link })).rejects.toThrow(
        'vc_ca_root_key_out_exists'
      );
      expect(existsSync(file(VC_CA_FILES.issuingPrivateKey))).toBe(false);
    } finally {
      await rm(outside, { recursive: true, force: true });
    }
  });

  it('refuses deploy-read names in any directory and other names inside the keys directory', async () => {
    const outside = await mkdtemp(join(tmpdir(), 'authrim-out-'));
    try {
      for (const target of [
        join(outside, 'admin_ui_bff_private.pem'),
        join(outside, 'private.pem'),
        file('anything-else.pem'),
      ]) {
        await expect(runVcCaInit({ env: 'prod', keysDir, rootKeyOut: target })).rejects.toThrow(
          'vc_ca_root_key_out_reserved'
        );
      }
      // A symlinked parent that leads back into the keys directory is the keys directory.
      const viaLink = join(outside, 'keys-link');
      symlinkSync(keysDir, viaLink);
      await expect(
        runVcCaInit({ env: 'prod', keysDir, rootKeyOut: join(viaLink, 'anything-else.pem') })
      ).rejects.toThrow('vc_ca_root_key_out_reserved');
    } finally {
      await rm(outside, { recursive: true, force: true });
    }
  });

  it('lets only one of two concurrent initialisations through, leaving a consistent CA', async () => {
    const results = await Promise.allSettled([
      runVcCaInit({ env: 'prod', keysDir }),
      runVcCaInit({ env: 'prod', keysDir }),
    ]);
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    const failure = results.find((r) => r.status === 'rejected') as PromiseRejectedResult;
    expect(['vc_ca_locked', 'vc_ca_exists']).toContain((failure.reason as Error).message);
    expect(existsSync(file('.vc-ca-init.lock'))).toBe(false);
    const root = new X509Certificate(await readFile(file(VC_CA_FILES.rootCertificate), 'utf8'));
    const issuing = new X509Certificate(
      Buffer.from(
        base64ToBytes((await readFile(file(VC_CA_FILES.issuingCertificate), 'utf8')).trim())
      )
    );
    expect(issuing.verify(root.publicKey)).toBe(true);
  });

  it('refuses while a lock file is present', async () => {
    await writeFile(file('.vc-ca-init.lock'), '');
    await expect(runVcCaInit({ env: 'prod', keysDir })).rejects.toThrow('vc_ca_locked');
  });

  it('keeps every generation when two replacements happen in the same second', async () => {
    await runVcCaInit({ env: 'prod', keysDir });
    const keys: string[] = [await readFile(file(VC_CA_FILES.issuingPrivateKey), 'utf8')];
    const rootKey = file(VC_CA_FILES.rootPrivateKey);
    const first = await runVcCaInit({ env: 'prod', keysDir, force: true, rootKey });
    keys.push(await readFile(file(VC_CA_FILES.issuingPrivateKey), 'utf8'));
    const second = await runVcCaInit({ env: 'prod', keysDir, force: true, rootKey });
    const backups = [...first.backedUp, ...second.backedUp].filter((path) =>
      path.includes(VC_CA_FILES.issuingPrivateKey)
    );
    expect(new Set(backups).size).toBe(2);
    const contents = await Promise.all(backups.map((path) => readFile(path, 'utf8')));
    expect(contents.sort()).toEqual([keys[0], keys[1]].sort());
  });

  it('recovers a lost fingerprint list from the surviving issuing certificate', async () => {
    const first = await runVcCaInit({ env: 'prod', keysDir });
    await rm(file(VC_CA_FILES.issuingFingerprints));
    const recovered = await runVcCaInit({
      env: 'prod',
      keysDir,
      force: true,
      rootKey: file(VC_CA_FILES.rootPrivateKey),
    });
    expect(recovered.fingerprints.split(',')).toEqual([
      recovered.material.issuingCertificateSha256,
      first.material.issuingCertificateSha256,
    ]);
  });

  it('refuses a root that did not issue the surviving issuing CA, when the saved root is gone', async () => {
    await runVcCaInit({ env: 'prod', keysDir });
    await rm(file(VC_CA_FILES.rootCertificate));
    const stranger = await generateVcCa({ environment: 'prod', now: new Date() });
    await writeFile(file('other-root.pem'), stranger.rootPrivateKeyPem ?? '');
    await writeFile(file('other-root-cert.pem'), stranger.rootCertificatePem);
    const before = await readFile(file(VC_CA_FILES.issuingCertificate), 'utf8');
    await expect(
      runVcCaInit({
        env: 'prod',
        keysDir,
        force: true,
        rootKey: file('other-root.pem'),
        rootCertificate: file('other-root-cert.pem'),
      })
    ).rejects.toThrow('vc_ca_root_does_not_match_issuing');
    expect(await readFile(file(VC_CA_FILES.issuingCertificate), 'utf8')).toBe(before);
  });

  it('refuses an outside root that forbids a subordinate CA', async () => {
    const first = await generateVcCa({ environment: 'prod', now: new Date() });
    // An issuing CA certificate (pathLen 0) offered as the root.
    const issuingPem = `-----BEGIN CERTIFICATE-----\n${first.issuingCertificateBase64}\n-----END CERTIFICATE-----\n`;
    await writeFile(file('as-root-cert.pem'), issuingPem);
    await writeFile(file('as-root.pem'), first.issuingPrivateKeyPem);
    await expect(
      runVcCaInit({
        env: 'prod',
        keysDir,
        rootKey: file('as-root.pem'),
        rootCertificate: file('as-root-cert.pem'),
      })
    ).rejects.toThrow('vc_ca_root_path_length');
  });

  it('writes the root key where asked, outside the keys directory', async () => {
    const offline = await mkdtemp(join(tmpdir(), 'authrim-offline-'));
    try {
      const target = join(offline, 'root.pem');
      const result = await runVcCaInit({ env: 'prod', keysDir, rootKeyOut: target });
      expect(result.rootKeyPath).toBe(target);
      expect((await stat(target)).mode & 0o777).toBe(0o600);
      expect(existsSync(file(VC_CA_FILES.rootPrivateKey))).toBe(false);
    } finally {
      await rm(offline, { recursive: true, force: true });
    }
  });

  it('remembers an outside root by its certificate for later renewals', async () => {
    const root = await generateVcCa({ environment: 'prod', now: new Date() });
    await writeFile(file('ext-root.pem'), root.rootPrivateKeyPem ?? '');
    await writeFile(file('ext-root-cert.pem'), root.rootCertificatePem);
    const result = await runVcCaInit({
      env: 'prod',
      keysDir,
      rootKey: file('ext-root.pem'),
      rootCertificate: file('ext-root-cert.pem'),
    });
    expect(result.createdRoot).toBe(false);
    expect(await readFile(file(VC_CA_FILES.rootCertificate), 'utf8')).toBe(root.rootCertificatePem);
  });

  it('rejects environment names that are not safe in a path', async () => {
    for (const env of ['../prod', 'Prod', 'a b', '']) {
      await expect(
        runVcCaInit({ env: env || ' ', keysDir: undefined, cwd: keysDir })
      ).rejects.toThrow('vc_ca_environment_invalid');
    }
  });
});

describe('where the CA files go, and that deploy reads them', () => {
  let project: string;

  beforeEach(async () => {
    project = await mkdtemp(join(tmpdir(), 'authrim-project-'));
  });

  afterEach(async () => {
    await rm(project, { recursive: true, force: true });
  });

  it('finds the keys directory the way deploy does', async () => {
    // Internal layout: .authrim/<env>/keys.
    await mkdir(join(project, '.authrim', 'prod', 'keys'), { recursive: true });
    expect(await resolveVcCaKeysDir({ env: 'prod', cwd: project })).toBe(
      join(project, '.authrim', 'prod', 'keys')
    );
    // A fresh install keeps its generated keys in .authrim-keys/<env>, which wins.
    await mkdir(join(project, '.authrim-keys', 'prod'), { recursive: true });
    expect(await resolveVcCaKeysDir({ env: 'prod', cwd: project })).toBe(
      join(project, '.authrim-keys', 'prod')
    );
    // An explicit directory wins over both.
    const explicit = join(project, 'elsewhere');
    expect(await resolveVcCaKeysDir({ env: 'prod', cwd: project, keysDir: explicit })).toBe(
      explicit
    );
  });

  it('writes files that deploy loads as the right secrets for the right Workers', async () => {
    await mkdir(join(project, '.authrim', 'prod'), { recursive: true });
    const keys = await resolveVcCaKeysDir({ env: 'prod', cwd: project });
    expect(keys).toBe(join(project, '.authrim-keys', 'prod'));
    await mkdir(keys, { recursive: true });
    await runVcCaInit({ env: 'prod', cwd: project });

    const forVc = await loadDeploySecretsFromKeys(keys, ['ar-vc']);
    const forCore = await loadDeploySecretsFromKeys(keys, ['ar-lib-core']);
    const pem = await readFile(join(keys, VC_CA_FILES.issuingPrivateKey), 'utf8');
    // The multi-line PEM arrives intact, and the other two are the files' contents.
    expect(forVc.VC_ISSUING_CA_PRIVATE_KEY_PEM).toBe(pem);
    expect(forVc.VC_ISSUING_CA_PRIVATE_KEY_PEM.split('\n').length).toBeGreaterThan(2);
    expect(forVc.VC_ISSUING_CA_CERTIFICATE.trim()).toBe(
      (await readFile(join(keys, VC_CA_FILES.issuingCertificate), 'utf8')).trim()
    );
    expect(forVc.VC_X5C_ISSUING_CA_SHA256.trim()).toBe(
      (await readFile(join(keys, VC_CA_FILES.issuingFingerprints), 'utf8')).trim()
    );
    expect(forCore.VC_X5C_ISSUING_CA_SHA256.trim()).toBe(forVc.VC_X5C_ISSUING_CA_SHA256.trim());
    // KeyManager's Worker never gets the private key.
    expect(forCore.VC_ISSUING_CA_PRIVATE_KEY_PEM).toBeUndefined();
    // The root key is not a deploy secret at all.
    for (const secrets of [forVc, forCore]) {
      expect(Object.values(secrets).join('')).not.toContain(
        (await readFile(join(keys, VC_CA_FILES.rootPrivateKey), 'utf8')).split('\n')[1]
      );
    }
  });
});

describe('the launcher', () => {
  it('makes the root key paths absolute before the CLI changes directory', () => {
    const resolved = resolveLauncherPaths(
      [
        'vc-ca-init',
        '--root-key',
        'root.pem',
        '--root-certificate=cert.pem',
        '--root-key-out',
        'offline/root.pem',
      ],
      '/work/dir'
    );
    expect(resolved).toEqual([
      'vc-ca-init',
      '--root-key',
      '/work/dir/root.pem',
      '--root-certificate=/work/dir/cert.pem',
      '--root-key-out',
      '/work/dir/offline/root.pem',
    ]);
  });
});

describe('the secret plan for the HAIP x5c CA', () => {
  it('uploads the CA to the credential issuer and the fingerprints to KeyManager’s Worker', () => {
    expect(SECRET_UPLOAD_PLAN['ar-vc']).toEqual(
      expect.arrayContaining([
        'VC_ISSUING_CA_PRIVATE_KEY_PEM',
        'VC_ISSUING_CA_CERTIFICATE',
        'VC_X5C_ISSUING_CA_SHA256',
      ])
    );
    expect(SECRET_UPLOAD_PLAN['ar-lib-core']).toContain('VC_X5C_ISSUING_CA_SHA256');
    // The private key goes to the credential issuer only.
    for (const [component, names] of Object.entries(SECRET_UPLOAD_PLAN)) {
      if (component !== 'ar-vc') expect(names).not.toContain('VC_ISSUING_CA_PRIVATE_KEY_PEM');
    }
  });

  it('is optional: an environment without the CA deploys as before', () => {
    for (const name of [
      'VC_ISSUING_CA_PRIVATE_KEY_PEM',
      'VC_ISSUING_CA_CERTIFICATE',
      'VC_X5C_ISSUING_CA_SHA256',
    ] as const) {
      expect(OPTIONAL_DEPLOY_SECRET_NAMES).toContain(name);
    }
  });
});

describe('deploy refuses a CA that is half there or of mixed generations', () => {
  it('checks completeness, key and certificate, and the fingerprint list', async () => {
    const keys = await mkdtemp(join(tmpdir(), 'authrim-keys-'));
    try {
      await runVcCaInit({ env: 'prod', keysDir: keys });
      await expect(loadDeploySecretsFromKeys(keys, ['ar-vc'])).resolves.toBeDefined();
      // Mixed generations: a new key with the old certificate.
      const other = await generateVcCa({ environment: 'prod', now: new Date() });
      const key = join(keys, VC_CA_FILES.issuingPrivateKey);
      const good = await readFile(key, 'utf8');
      await writeFile(key, other.issuingPrivateKeyPem);
      await expect(loadDeploySecretsFromKeys(keys, ['ar-vc'])).rejects.toThrow(
        'vc_ca_files_key_mismatch'
      );
      await writeFile(key, good);
      // The fingerprint list lacks the certificate.
      await writeFile(join(keys, VC_CA_FILES.issuingFingerprints), `${'0'.repeat(64)}\n`);
      await expect(loadDeploySecretsFromKeys(keys, ['ar-vc'])).rejects.toThrow(
        'vc_ca_files_fingerprint_not_listed'
      );
      // A file missing.
      await rm(join(keys, VC_CA_FILES.issuingCertificate));
      await expect(loadDeploySecretsFromKeys(keys, ['ar-vc'])).rejects.toThrow(
        'vc_ca_files_incomplete'
      );
    } finally {
      await rm(keys, { recursive: true, force: true });
    }
  });
});
