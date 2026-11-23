import type { TransformStep } from './mapping-model';

/**
 * What a persistent identifier looks like, for the sample output of a mapping. The real value
 * is made at sign-in from the account, the app and a salt, so this one is made up: the same
 * shape the algorithm and the format give (length, characters, the "!" and "@" parts), from
 * a fixed seed, so it does not change between renderings and says nothing about any person.
 *
 * The shapes follow `computeIdentifier` and the framing of `mapped-identifiers` in
 * @authrim/ar-lib-core, which this console does not run (it needs the salt):
 * - `authrim_sha256`: Base64url of a SHA-256, 43 characters.
 * - `shibboleth`: Base64 (padded) or Base32 (padded) of the digest chosen (SHA-1 by default).
 * - `keycloak_sha256`: a version 3 UUID.
 * - `simplesamlphp_targeted_id`, `simplesamlphp_persistent_nameid`: 40 hex digits.
 * - `simplesamlphp_pairwise_id`, `simplesamlphp_subject_id`: 64 hex digits, "@" and the scope.
 * and the format puts it into its carrier: as is, `IdP!SP!identifier` (a targeted ID), or
 * `identifier@scope` (pairwise and subject IDs).
 */

/** The two parties a made-up targeted ID names. */
export const PREVIEW_IDP = 'https://idp.example.org/idp';
export const PREVIEW_SP = 'https://sp.example.org/sp';
/** The scope shown when none is set (a scope is the domain after the "@"). */
export const PREVIEW_SCOPE = 'example.org';

/** A small seeded generator (mulberry32): the same seed always gives the same characters. */
function generator(seed: string): () => number {
	let state = 0;
	for (const char of seed) state = (Math.imul(state, 31) + char.charCodeAt(0)) >>> 0;
	return () => {
		state = (state + 0x6d2b79f5) >>> 0;
		let t = state;
		t = Math.imul(t ^ (t >>> 15), t | 1);
		t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
		return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
	};
}

const BASE64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
const BASE64URL = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';
const BASE32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
const HEX = '0123456789abcdef';

function pick(next: () => number, alphabet: string, length: number): string {
	let out = '';
	for (let i = 0; i < length; i += 1) out += alphabet[Math.floor(next() * alphabet.length)];
	return out;
}

/** Bytes in each digest Shibboleth can be set to. */
const DIGEST_BYTES: Record<string, number> = {
	'SHA-1': 20,
	'SHA-256': 32,
	'SHA-384': 48,
	'SHA-512': 64
};

function shibboleth(next: () => number, digest: string, encoding: string): string {
	const bytes = DIGEST_BYTES[digest] ?? 20;
	if (encoding === 'base32') {
		// 5 bytes make 8 characters; the last group is padded with "=".
		const length = Math.ceil((bytes * 8) / 5);
		const padded = Math.ceil(bytes / 5) * 8;
		return pick(next, BASE32, length) + '='.repeat(padded - length);
	}
	const length = Math.ceil((bytes * 4) / 3);
	const padded = Math.ceil(bytes / 3) * 4;
	// The alphabet's last characters are mostly "+" and "/": keep the text readable.
	return pick(next, BASE64.slice(0, 62), length) + '='.repeat(padded - length);
}

function uuidV3(next: () => number): string {
	const hex = (n: number) => pick(next, HEX, n);
	return `${hex(8)}-${hex(4)}-3${hex(3)}-${'89ab'[Math.floor(next() * 4)]}${hex(3)}-${hex(12)}`;
}

/**
 * A made-up identifier of the shape these settings give, or null when they do not name a shape
 * (no algorithm chosen yet). `params` are the step's settings as the editor holds them.
 */
export function pseudoPersistentIdentifier(params: TransformStep['params']): string | null {
	const algorithm = typeof params.algorithm === 'string' ? params.algorithm : '';
	if (!algorithm) return null;
	const format = typeof params.format === 'string' ? params.format : 'plain';
	const scope =
		typeof params.scope === 'string' && params.scope.trim() ? params.scope.trim() : PREVIEW_SCOPE;
	const next = generator(`authrim-preview:${algorithm}`);

	let opaque: string;
	switch (algorithm) {
		case 'authrim_sha256':
			opaque = pick(next, BASE64URL, 43);
			break;
		case 'shibboleth':
			opaque = shibboleth(
				next,
				typeof params.digest === 'string' ? params.digest : 'SHA-1',
				typeof params.encoding === 'string' ? params.encoding : 'base64'
			);
			break;
		case 'keycloak_sha256':
			opaque = uuidV3(next);
			break;
		case 'simplesamlphp_targeted_id':
		case 'simplesamlphp_persistent_nameid':
			opaque = pick(next, HEX, 40);
			break;
		case 'simplesamlphp_pairwise_id':
		case 'simplesamlphp_subject_id':
			opaque = `${pick(next, HEX, 64)}@${scope}`;
			break;
		default:
			return null;
	}

	switch (format) {
		case 'saml_targeted_id':
			return `${PREVIEW_IDP}!${PREVIEW_SP}!${opaque}`;
		case 'saml_pairwise_id':
		case 'saml_subject_id':
			// SimpleSAMLphp's algorithms already end in "@scope"; the others are scoped here.
			return opaque.includes('@') ? opaque : `${opaque}@${scope}`;
		default:
			return opaque;
	}
}
