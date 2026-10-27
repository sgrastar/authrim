import { randomUUID, webcrypto } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';
import { Client } from 'pg';
import { verifyAuthenticationResponse } from '@simplewebauthn/server';
import { PostgresAccountAuthStateStore } from '../storage/postgres-account-auth-state';
import {
  PostgresTransientStateStore,
  type PostgresQueryClient,
} from '../storage/postgres-transient-state';

const databaseUrl = process.env.AUTHRIM_AWS_TEST_DATABASE_URL;
const postgresIt = databaseUrl ? it : it.skip;
const base64url = (value: Uint8Array) =>
  btoa(String.fromCharCode(...value))
    .replace(/\+/gu, '-')
    .replace(/\//gu, '_')
    .replace(/=+$/u, '');

function fromBase64url(value: string): Uint8Array {
  const decoded = atob(value.replace(/-/gu, '+').replace(/_/gu, '/'));
  return Uint8Array.from(decoded, (character) => character.charCodeAt(0));
}

async function sha256(value: Uint8Array): Promise<Uint8Array> {
  return new Uint8Array(await webcrypto.subtle.digest('SHA-256', value));
}

function derSignature(raw: Uint8Array): Uint8Array {
  const integer = (bytes: Uint8Array) => {
    let offset = 0;
    while (offset < bytes.length - 1 && bytes[offset] === 0) offset += 1;
    const value = Array.from(bytes.slice(offset));
    if (value[0] & 0x80) value.unshift(0);
    return [2, value.length, ...value];
  };
  const integers = [...integer(raw.slice(0, 32)), ...integer(raw.slice(32))];
  return new Uint8Array([0x30, integers.length, ...integers]);
}

async function signedAssertion(challenge: string, rpId: string) {
  const keys = await webcrypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, [
    'sign',
    'verify',
  ]);
  const jwk = await webcrypto.subtle.exportKey('jwk', keys.publicKey);
  if (!jwk.x || !jwk.y) throw new Error('Generated passkey JWK lacks coordinates');
  const publicKey = new Uint8Array([
    0xa5,
    1,
    2,
    3,
    0x26,
    0x20,
    1,
    0x21,
    0x58,
    32,
    ...fromBase64url(jwk.x),
    0x22,
    0x58,
    32,
    ...fromBase64url(jwk.y),
  ]);
  const clientData = new TextEncoder().encode(
    JSON.stringify({
      type: 'webauthn.get',
      challenge,
      origin: `https://${rpId}`,
      crossOrigin: false,
    })
  );
  const authData = new Uint8Array([
    ...(await sha256(new TextEncoder().encode(rpId))),
    5,
    0,
    0,
    0,
    1,
  ]);
  const signature = derSignature(
    new Uint8Array(
      await webcrypto.subtle.sign(
        { name: 'ECDSA', hash: 'SHA-256' },
        keys.privateKey,
        new Uint8Array([...authData, ...(await sha256(clientData))])
      )
    )
  );
  const id = base64url(new Uint8Array([1, 2, 3]));
  return {
    response: {
      id,
      rawId: id,
      type: 'public-key' as const,
      response: {
        clientDataJSON: base64url(clientData),
        authenticatorData: base64url(authData),
        signature: base64url(signature),
      },
      clientExtensionResults: {},
    },
    credential: { id, publicKey, counter: 0 },
  };
}

describe('AWS signed passkey proof against PostgreSQL state', () => {
  postgresIt('accepts one signed assertion and rejects challenge/counter replay', async () => {
    const client = new Client({ connectionString: databaseUrl });
    const schema = `aws_signed_passkey_${randomUUID().replace(/-/gu, '')}`;
    await client.connect();
    try {
      await client.query(`CREATE SCHEMA "${schema}"`);
      await client.query(`SET search_path TO "${schema}"`);
      await client.query(await readFile(new URL('../storage/schema.sql', import.meta.url), 'utf8'));
      await client.query(
        await readFile(new URL('../storage/account-auth-schema.sql', import.meta.url), 'utf8')
      );
      const pg = client as unknown as PostgresQueryClient;
      const transient = new PostgresTransientStateStore(pg);
      const accounts = new PostgresAccountAuthStateStore(pg);
      await accounts.initializeAccountStateRpc(
        'tenant-a',
        'user-a',
        'account:user-a',
        'active',
        Date.now() - 1000
      );
      const challenge = base64url(webcrypto.getRandomValues(new Uint8Array(32)));
      expect(
        await transient.storeChallenge({
          tenantId: 'tenant-a',
          id: 'direct_passkey_login:attempt-a',
          type: 'direct_passkey_login',
          userId: 'unknown',
          challenge,
          ttlMs: 60_000,
        })
      ).toBe(true);
      const consumed = await transient.consumeChallenge({
        tenantId: 'tenant-a',
        id: 'direct_passkey_login:attempt-a',
        type: 'direct_passkey_login',
      });
      expect(consumed?.challenge).toBe(challenge);
      if (!consumed) throw new Error('challenge_missing');
      const signed = await signedAssertion(consumed.challenge, 'login.example.test');
      const verified = await verifyAuthenticationResponse({
        response: signed.response,
        expectedChallenge: consumed.challenge,
        expectedOrigin: 'https://login.example.test',
        expectedRPID: 'login.example.test',
        credential: signed.credential,
        requireUserVerification: true,
      });
      expect(verified.verified).toBe(true);
      expect(verified.authenticationInfo.newCounter).toBe(1);
      await expect(
        accounts.advancePasskeyCounterRpc(
          'tenant-a',
          'user-a',
          'account:user-a',
          signed.credential.id,
          0,
          verified.authenticationInfo.newCounter,
          Date.now()
        )
      ).resolves.toMatchObject({ counter: 1, advanced: true });
      const session = await transient.createSession({
        tenantId: 'tenant-a',
        sessionId: 'g1:apac:0:session_abcdefghijklmnopqrstuv',
        userId: 'user-a',
        ttlMs: 60_000,
        data: { amr: ['passkey'], authTime: Math.floor(Date.now() / 1000) },
      });
      expect(session.userId).toBe('user-a');
      expect(
        await transient.consumeChallenge({
          tenantId: 'tenant-a',
          id: 'direct_passkey_login:attempt-a',
          type: 'direct_passkey_login',
        })
      ).toBeNull();
      await expect(
        accounts.advancePasskeyCounterRpc(
          'tenant-a',
          'user-a',
          'account:user-a',
          signed.credential.id,
          0,
          verified.authenticationInfo.newCounter,
          Date.now()
        )
      ).rejects.toThrow('passkey_counter_replay');
      await expect(
        verifyAuthenticationResponse({
          response: signed.response,
          expectedChallenge: 'a-different-challenge',
          expectedOrigin: 'https://login.example.test',
          expectedRPID: 'login.example.test',
          credential: signed.credential,
          requireUserVerification: true,
        })
      ).rejects.toThrow();
    } finally {
      await client.query('SET search_path TO public').catch(() => undefined);
      await client.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`).catch(() => undefined);
      await client.end();
    }
  });
});
