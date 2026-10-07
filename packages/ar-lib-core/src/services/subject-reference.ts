/**
 * The sealed reference to a user's account that a token carries when its sub is not the user's id
 * (a pairwise or persistent identifier issued by identity mapping). Only the authorization server
 * can open it, so the token keeps the client's view of the user while a Token Exchange or an
 * introspection of it can still find the account (its state and its consent withdrawals).
 *
 * AES-256-GCM under a key derived (HKDF) from OBJECT_ENCRYPTION_ROOT_KEY for this purpose only,
 * bound to the tenant and to the client whose consent the token was granted under.
 */

import type { Env } from '../types/env';
import { isNonAccountSubject } from '../utils/id';
import { ACCESS_TOKEN_CONSENT_GENERATION_CLAIM } from './oauth-client-consent-revocation';

export const SUBJECT_REFERENCE_CLAIM = 'authrim_subject_ref';

const REFERENCE_PREFIX = 'sr1.';
const ROOT_KEY_HEX = /^[0-9a-fA-F]{64}$/u;
const encoder = new TextEncoder();
const decoder = new TextDecoder();

type SubjectReferenceEnv = Pick<Env, 'OBJECT_ENCRYPTION_ROOT_KEY'>;

export interface SubjectReferenceBinding {
  tenantId: string;
  /** The client whose consent the token was granted under. */
  clientId: string;
}

function hexToBytes(hex: string): Uint8Array {
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < hex.length; i += 2) bytes[i / 2] = parseInt(hex.slice(i, i + 2), 16);
  return bytes;
}

function toBase64Url(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}

function fromBase64Url(value: string): Uint8Array {
  const binary = atob(
    value
      .replace(/-/g, '+')
      .replace(/_/g, '/')
      .padEnd(Math.ceil(value.length / 4) * 4, '=')
  );
  return Uint8Array.from(binary, (char) => char.charCodeAt(0));
}

/** Whether subject references can be sealed and opened here. */
export function isSubjectReferenceAvailable(env: SubjectReferenceEnv): boolean {
  return (
    typeof env.OBJECT_ENCRYPTION_ROOT_KEY === 'string' &&
    ROOT_KEY_HEX.test(env.OBJECT_ENCRYPTION_ROOT_KEY)
  );
}

async function referenceKey(env: SubjectReferenceEnv): Promise<CryptoKey> {
  if (!isSubjectReferenceAvailable(env)) throw new Error('subject_reference_key_unavailable');
  const material = await crypto.subtle.importKey(
    'raw',
    hexToBytes(env.OBJECT_ENCRYPTION_ROOT_KEY as string),
    'HKDF',
    false,
    ['deriveKey']
  );
  return crypto.subtle.deriveKey(
    {
      name: 'HKDF',
      hash: 'SHA-256',
      salt: encoder.encode('authrim-subject-reference'),
      info: encoder.encode('authrim:subject-reference:v1'),
    },
    material,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt']
  );
}

function additionalData(binding: SubjectReferenceBinding): Uint8Array {
  return encoder.encode(`${binding.tenantId}\u0000${binding.clientId}`);
}

/** Seal a user's id for a token of `binding`. Throws when the key is unavailable. */
export async function sealSubjectReference(
  env: SubjectReferenceEnv,
  binding: SubjectReferenceBinding,
  userId: string
): Promise<string> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ciphertext = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv, additionalData: additionalData(binding), tagLength: 128 },
    await referenceKey(env),
    encoder.encode(userId)
  );
  return `${REFERENCE_PREFIX}${toBase64Url(iv)}.${toBase64Url(new Uint8Array(ciphertext))}`;
}

/**
 * The user id a reference seals, or null when it does not open for `binding` (another tenant or
 * client, another key, or not a reference). Throws when the key is unavailable.
 */
export async function openSubjectReference(
  env: SubjectReferenceEnv,
  binding: SubjectReferenceBinding,
  reference: string
): Promise<string | null> {
  const key = await referenceKey(env);
  if (!reference.startsWith(REFERENCE_PREFIX)) return null;
  const [iv, ciphertext, ...rest] = reference.slice(REFERENCE_PREFIX.length).split('.');
  if (!iv || !ciphertext || rest.length > 0) return null;
  try {
    const plaintext = await crypto.subtle.decrypt(
      {
        name: 'AES-GCM',
        iv: fromBase64Url(iv),
        additionalData: additionalData(binding),
        tagLength: 128,
      },
      key,
      fromBase64Url(ciphertext)
    );
    const userId = decoder.decode(plaintext);
    return userId.length > 0 ? userId : null;
  } catch {
    return null;
  }
}

/**
 * Whether a token records a user's grant: a consent generation or a sealed account reference,
 * which only the authorization server writes on the tokens of a user's grant.
 */
export function tokenRecordsUserGrant(payload: Record<string, unknown>): boolean {
  return (
    payload[SUBJECT_REFERENCE_CLAIM] !== undefined ||
    payload[ACCESS_TOKEN_CONSENT_GENERATION_CLAIM] !== undefined
  );
}

/**
 * The signed claim a Token Exchange puts on a token whose subject token named a client or admin
 * principal: the exchanged token keeps the subject's sub but has another client_id, so the
 * evidence its issuance path signed would no longer hold. Only the authorization server writes it.
 */
export const SUBJECT_PRINCIPAL_CLAIM = 'authrim_subject_principal';

export type NonAccountPrincipalKind = 'client' | 'machine' | 'admin_agent';

const PRINCIPAL_SUBJECT_PREFIX: Record<NonAccountPrincipalKind, string> = {
  client: 'client:',
  machine: 'machine:',
  admin_agent: 'admin_user:',
};

/**
 * The client or admin principal a token names rather than a user, from what its issuance path
 * signed (a sub in the principal's namespace alone is not enough: an identity mapping chose the sub
 * of an ID token issued before mapped subs were refused):
 * - client credentials: sub `client:<its client_id>`;
 * - an admin machine: sub `machine:<its actor_id>`, actor_type machine;
 * - an admin agent delegation: sub `admin_user:<id>`, with its Agent Grant and actor mode;
 * - a Token Exchange of any of these: the subject-principal claim, matching the sub's namespace.
 * Only an access or refresh token (one with a token_use and a JWT ID) qualifies: an ID token is
 * always for a user, and a token recording a user's grant names an account. null: a user.
 */
export function nonAccountPrincipalKind(
  payload: Record<string, unknown>
): NonAccountPrincipalKind | null {
  if (tokenRecordsUserGrant(payload)) return null;
  if (typeof payload.token_use !== 'string') return null;
  // Every access and refresh token Authrim issues has a JWT ID; an ID token has none, and no
  // identity mapping output or custom claim may set one.
  if (typeof payload.jti !== 'string' || payload.jti.length === 0) return null;
  const sub = payload.sub;
  if (typeof sub !== 'string' || !isNonAccountSubject(sub)) return null;
  const claimed = payload[SUBJECT_PRINCIPAL_CLAIM];
  if (
    typeof claimed === 'string' &&
    Object.prototype.hasOwnProperty.call(PRINCIPAL_SUBJECT_PREFIX, claimed)
  ) {
    const kind = claimed as NonAccountPrincipalKind;
    return sub.startsWith(PRINCIPAL_SUBJECT_PREFIX[kind]) ? kind : null;
  }
  if (sub.startsWith('client:')) {
    return typeof payload.client_id === 'string' && sub === `client:${payload.client_id}`
      ? 'client'
      : null;
  }
  if (sub.startsWith('machine:')) {
    return payload.actor_type === 'machine' &&
      typeof payload.actor_id === 'string' &&
      sub === `machine:${payload.actor_id}`
      ? 'machine'
      : null;
  }
  return typeof payload.grant_id === 'string' &&
    payload.grant_id.length > 0 &&
    (payload.actor_mode === 'mode_a' || payload.actor_mode === 'mode_b')
    ? 'admin_agent'
    : null;
}

/** Whether a token names a client or admin principal rather than a user (see above). */
export function tokenNamesNonAccountPrincipal(payload: Record<string, unknown>): boolean {
  return nonAccountPrincipalKind(payload) !== null;
}

/**
 * Whether a token's subject is a user account, to hold the token to the account's state and
 * consent: every subject is, but a client or admin principal its issuance path signed as one. One
 * whose account cannot be found is then refused.
 */
export function tokenNamesAccountSubject(payload: Record<string, unknown>): boolean {
  return (
    typeof payload.sub === 'string' &&
    payload.sub.length > 0 &&
    !tokenNamesNonAccountPrincipal(payload)
  );
}
