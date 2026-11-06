import { describe, expect, it, vi } from 'vitest';
import type { RequestEvent } from '@sveltejs/kit';
import { LITE_BINDING_COOKIE, ensureBrowserBinding, readBrowserBinding } from '../browser-binding';
import { liteTxnClient } from '../txn-client';

function event(cookies: Record<string, string> = {}, edge?: Record<string, unknown>) {
	const jar = new Map(Object.entries(cookies));
	const set = vi.fn((name: string, value: string) => jar.set(name, value));
	const service = {
		create: vi.fn(async () => ({ ok: true })),
		get: vi.fn(async () => ({ ok: true })),
		transition: vi.fn(async () => ({ ok: true })),
		beginOperation: vi.fn(async () => ({ ok: true, status: 'started', attempt: 1 })),
		completeOperation: vi.fn(async () => ({ ok: true })),
		issueStartGrant: vi.fn(async () => ({ ok: true, grantId: 'g' }))
	};
	const e = {
		url: new URL('https://login.example/login?tenant_host=other.example'),
		cookies: { get: (name: string) => jar.get(name), set },
		locals: { edge },
		platform: { env: { LITE_TXN: service } }
	} as unknown as RequestEvent;
	return { e, set, service };
}

const BINDING = 'Z'.repeat(43);

describe('the browser binding cookie', () => {
	it('is a host-only, HttpOnly, Secure, Lax cookie with 32 random bytes', () => {
		const { e, set } = event();
		const { binding, created } = ensureBrowserBinding(e);
		expect(created).toBe(true);
		expect(binding).toMatch(/^[A-Za-z0-9_-]{43}$/u);
		expect(set).toHaveBeenCalledWith(LITE_BINDING_COOKIE, binding, {
			path: '/',
			httpOnly: true,
			secure: true,
			sameSite: 'lax',
			maxAge: 30 * 24 * 60 * 60
		});
		expect(ensureBrowserBinding(e)).toEqual({ binding, created: false });
	});

	it('ignores a malformed cookie', () => {
		expect(readBrowserBinding(event({ [LITE_BINDING_COOKIE]: 'short' }).e)).toBeNull();
	});
});

describe('the lite transaction client', () => {
	it('takes the origin and IP from the edge context, never from the query', async () => {
		const { e, service } = event(
			{ [LITE_BINDING_COOKIE]: BINDING },
			{ source: 'router', publicOrigin: 'https://id.example', clientIp: '203.0.113.9' }
		);
		const txns = liteTxnClient(e);
		await txns?.create({ purpose: 'login', clientId: 'c' });
		expect(service.create).toHaveBeenCalledWith({
			purpose: 'login',
			clientId: 'c',
			publicOrigin: 'https://id.example',
			binding: BINDING,
			clientIp: '203.0.113.9'
		});
		await txns?.transition('t1', { expectedVersion: 1, to: 'pending' });
		expect(service.transition).toHaveBeenCalledWith({
			publicOrigin: 'https://id.example',
			binding: BINDING,
			txnId: 't1',
			expectedVersion: 1,
			to: 'pending'
		});
	});

	it('answers invalid_binding without a binding cookie, except when creating', async () => {
		const { e, service, set } = event({}, { publicOrigin: 'https://id.example', clientIp: null });
		const txns = liteTxnClient(e);
		await expect(txns?.get('t1')).resolves.toEqual({ ok: false, reason: 'invalid_binding' });
		expect(service.get).not.toHaveBeenCalled();
		await txns?.create({ purpose: 'login' });
		expect(set).toHaveBeenCalledTimes(1);
	});

	it('is null without the LITE_TXN binding', () => {
		const e = {
			url: new URL('https://login.example/'),
			locals: {},
			platform: { env: {} }
		} as unknown as RequestEvent;
		expect(liteTxnClient(e)).toBeNull();
	});
});
