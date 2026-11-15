import { describe, expect, it } from 'vitest';
import {
	checkPublicJwk,
	keyExpiry,
	keyNotYetValid,
	keyUsable,
	permissionProblem,
	reachProblem,
	tokenTtlProblem
} from './machine-model';

const ec = { kty: 'EC', crv: 'P-256', x: 'abc', y: 'def' };
const rsa = { kty: 'RSA', n: 'abc', e: 'AQAB' };

describe('checkPublicJwk', () => {
	it('accepts an EC key and works the algorithm out', () => {
		const result = checkPublicJwk(JSON.stringify(ec));
		expect(result).toMatchObject({ ok: true, alg: 'ES256' });
	});

	it('takes the algorithm an RSA key names, else RS256', () => {
		expect(checkPublicJwk(JSON.stringify(rsa))).toMatchObject({ ok: true, alg: 'RS256' });
		expect(checkPublicJwk(JSON.stringify({ ...rsa, alg: 'PS256' }))).toMatchObject({
			ok: true,
			alg: 'PS256'
		});
	});

	it('refuses every private member before anything is sent', () => {
		for (const member of ['d', 'p', 'q', 'dp', 'dq', 'qi', 'oth', 'k']) {
			expect(checkPublicJwk(JSON.stringify({ ...ec, [member]: 'x' }))).toEqual({
				ok: false,
				problem: 'private'
			});
		}
	});

	it('returns a new object with only allowlisted members', () => {
		const input = {
			...ec,
			kid: 'k1',
			backup: { d: 'secret' },
			unknown: 'x',
			key_ops: ['verify']
		};
		const result = checkPublicJwk(JSON.stringify(input));
		expect(result.ok).toBe(true);
		if (result.ok) {
			expect(result.jwk).toEqual({ ...ec, kid: 'k1', key_ops: ['verify'] });
			expect(JSON.stringify(result.jwk)).not.toContain('secret');
		}
	});

	it('names what is wrong with the text', () => {
		expect(checkPublicJwk('  ')).toEqual({ ok: false, problem: 'empty' });
		expect(checkPublicJwk('{nope')).toEqual({ ok: false, problem: 'notJson' });
		expect(checkPublicJwk('[1]')).toEqual({ ok: false, problem: 'notObject' });
		expect(checkPublicJwk('{"kty":"oct"}')).toEqual({ ok: false, problem: 'keyType' });
		expect(checkPublicJwk(JSON.stringify({ ...ec, use: 'enc' }))).toEqual({
			ok: false,
			problem: 'use'
		});
		expect(checkPublicJwk(JSON.stringify({ ...ec, key_ops: ['sign'] }))).toEqual({
			ok: false,
			problem: 'keyOps'
		});
	});

	it('refuses a key that does not fit the chosen algorithm', () => {
		expect(checkPublicJwk(JSON.stringify(ec), 'RS256')).toEqual({
			ok: false,
			problem: 'algorithm'
		});
		expect(checkPublicJwk(JSON.stringify(rsa), 'ES256')).toEqual({
			ok: false,
			problem: 'algorithm'
		});
		expect(checkPublicJwk(JSON.stringify({ ...ec, alg: 'PS256' }))).toEqual({
			ok: false,
			problem: 'algorithm'
		});
	});
});

describe('field checks', () => {
	it('holds permissions to one word', () => {
		expect(permissionProblem('admin:users:read')).toBeUndefined();
		expect(permissionProblem('admin users')).toBe('space');
		expect(permissionProblem('a'.repeat(201))).toBe('long');
	});

	it('keeps the token lifetime within the API maximum', () => {
		expect(tokenTtlProblem(600)).toBeUndefined();
		expect(tokenTtlProblem(900)).toBeUndefined();
		expect(tokenTtlProblem(901)).toBe('range');
		expect(tokenTtlProblem(0)).toBe('range');
		expect(tokenTtlProblem(1.5)).toBe('range');
		expect(tokenTtlProblem(null)).toBe('required');
	});

	it('asks for a tenant when tenants are chosen', () => {
		expect(reachProblem({ mode: 'tenants', tenantIds: [] })).toBe('noTenants');
		expect(reachProblem({ mode: 'tenants', tenantIds: ['a'] })).toBeUndefined();
		expect(reachProblem({ mode: 'none' })).toBeUndefined();
	});

	it('works out a key end and whether a key can still sign in', () => {
		expect(keyExpiry(null)).toBeUndefined();
		expect(keyExpiry(2, 0)).toBe(2 * 86_400_000);
		expect(keyUsable({ status: 'active', expiresAt: null }, 10)).toBe(true);
		expect(keyUsable({ status: 'active', expiresAt: 5 }, 10)).toBe(false);
		expect(keyUsable({ status: 'revoked', expiresAt: null }, 10)).toBe(false);
		// A key that has not started yet cannot sign in.
		expect(keyUsable({ status: 'active', expiresAt: null, notBefore: 20 }, 10)).toBe(false);
		expect(keyUsable({ status: 'active', expiresAt: null, notBefore: 10 }, 10)).toBe(true);
		expect(keyUsable({ status: 'active', expiresAt: null, notBefore: 5 }, 10)).toBe(true);
		expect(keyUsable({ status: 'active', expiresAt: null, notBefore: null }, 10)).toBe(true);
		expect(keyNotYetValid({ status: 'active', notBefore: 20 }, 10)).toBe(true);
		expect(keyNotYetValid({ status: 'revoked', notBefore: 20 }, 10)).toBe(false);
		expect(keyNotYetValid({ status: 'active', notBefore: null }, 10)).toBe(false);
	});
});
