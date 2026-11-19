import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
	DELETED_TENANT_NOTICE_PATH,
	MAX_REMEMBERED_PASSKEY_USER_HANDLES,
	PASSKEY_USER_HANDLES_STORAGE_KEY,
	isTenantOfThisHostDeleted,
	leaveForNoticeIfTenantDeleted,
	rememberPasskeyUserOfAssertion,
	rememberPasskeyUserOfRegistration
} from './deleted-tenant';

const HOST = window.location.hostname;
const stored = () => window.localStorage.getItem(PASSKEY_USER_HANDLES_STORAGE_KEY);

function answer(body: unknown, ok = true): typeof fetch {
	return vi.fn(async () => ({ ok, json: async () => body }) as Response) as unknown as typeof fetch;
}

beforeEach(() => {
	window.localStorage.clear();
});

describe('the list shared with the Login UI', () => {
	// The Login UI reads what the console writes: same key, same bound, same value format.
	// Tests run with the package as the working directory.
	const loginUi = readFileSync(
		resolve(process.cwd(), '../ar-login-ui/src/lib/webauthn/deleted-tenant.ts'),
		'utf8'
	);

	it('uses the Login UI storage key and bound', () => {
		expect(loginUi).toContain(`const STORAGE_KEY = '${PASSKEY_USER_HANDLES_STORAGE_KEY}';`);
		expect(loginUi).toContain(`const MAX_REMEMBERED = ${MAX_REMEMBERED_PASSKEY_USER_HANDLES};`);
	});

	it('accepts the same user handles', () => {
		const pattern = 'const USER_HANDLE = /^[A-Za-z0-9_-]{1,86}$/u;';
		const console = readFileSync(resolve(process.cwd(), 'src/lib/auth/deleted-tenant.ts'), 'utf8');
		expect(loginUi).toContain(pattern);
		expect(console).toContain(pattern);
	});

	it('hands over to a page the Login UI serves', () => {
		expect(DELETED_TENANT_NOTICE_PATH).toBe('/login');
	});
});

describe('remembering an administrator', () => {
	it('takes the owner from an assertion and from creation options, newest last', () => {
		rememberPasskeyUserOfAssertion({ response: { userHandle: 'YWRtaW4tYQ' } });
		rememberPasskeyUserOfRegistration({ user: { id: 'YWRtaW4tYg' } });
		rememberPasskeyUserOfAssertion({ response: { userHandle: 'YWRtaW4tYQ' } });
		expect(stored()).toBe(JSON.stringify(['YWRtaW4tYg', 'YWRtaW4tYQ']));
	});

	it('keeps what the Login UI already remembered', () => {
		window.localStorage.setItem(PASSKEY_USER_HANDLES_STORAGE_KEY, JSON.stringify(['dXNlci0x']));
		rememberPasskeyUserOfAssertion({ response: { userHandle: 'YWRtaW4tYQ' } });
		expect(stored()).toBe(JSON.stringify(['dXNlci0x', 'YWRtaW4tYQ']));
	});

	it('keeps at most eight, dropping the oldest', () => {
		for (let index = 0; index < 10; index++) {
			rememberPasskeyUserOfRegistration({ user: { id: `admin-${index}` } });
		}
		const kept = JSON.parse(stored() ?? '[]') as string[];
		expect(kept).toHaveLength(8);
		expect(kept[0]).toBe('admin-2');
		expect(kept[7]).toBe('admin-9');
	});

	it.each([
		{ response: {} },
		{ response: { userHandle: 'has space' } },
		{ response: { userHandle: 7 } },
		null,
		undefined
	])('ignores %j', (credential) => {
		rememberPasskeyUserOfAssertion(credential);
		expect(stored()).toBeNull();
	});

	it('replaces a stored value that is not a list of handles', () => {
		window.localStorage.setItem(PASSKEY_USER_HANDLES_STORAGE_KEY, '{"not":"a list"}');
		rememberPasskeyUserOfRegistration({ user: { id: 'YWRtaW4tYQ' } });
		expect(stored()).toBe(JSON.stringify(['YWRtaW4tYQ']));
	});

	it('does not throw when storage is blocked', () => {
		const set = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
			throw new Error('blocked');
		});
		expect(() => rememberPasskeyUserOfRegistration({ user: { id: 'YWRtaW4tYQ' } })).not.toThrow();
		set.mockRestore();
	});
});

describe('isTenantOfThisHostDeleted', () => {
	it('is true only for a deleted answer about this very host', async () => {
		const fetcher = answer({ status: 'deleted', host: HOST });
		await expect(isTenantOfThisHostDeleted(fetcher)).resolves.toBe(true);
		expect(fetcher).toHaveBeenCalledWith(
			'/api/auth/tenant-status',
			expect.objectContaining({ method: 'GET', cache: 'no-store', credentials: 'omit' })
		);
	});

	it.each([
		['a deleted answer about another host', { status: 'deleted', host: 'gone.example.com' }],
		['a deleted answer naming no host', { status: 'deleted' }],
		['an unavailable answer', { status: 'unavailable', host: HOST }],
		['an error body', { error: 'temporarily_unavailable' }],
		['null', null]
	])('is false for %s', async (_name, body) => {
		await expect(isTenantOfThisHostDeleted(answer(body))).resolves.toBe(false);
	});

	it('is false for a failed response or a failed request', async () => {
		await expect(
			isTenantOfThisHostDeleted(answer({ status: 'deleted', host: HOST }, false))
		).resolves.toBe(false);
		const rejected = vi.fn(async () => {
			throw new Error('offline');
		}) as unknown as typeof fetch;
		await expect(isTenantOfThisHostDeleted(rejected)).resolves.toBe(false);
	});
});

describe('leaveForNoticeIfTenantDeleted', () => {
	it('leaves for the Login UI notice when the tenant was deleted', async () => {
		const leave = vi.fn();
		await expect(
			leaveForNoticeIfTenantDeleted(answer({ status: 'deleted', host: HOST }), leave)
		).resolves.toBe(true);
		expect(leave).toHaveBeenCalledWith('/login');
	});

	it.each([
		['unavailable', { status: 'unavailable' }],
		['about another host', { status: 'deleted', host: 'gone.example.com' }]
	])('stays when the answer is %s', async (_name, body) => {
		const leave = vi.fn();
		await expect(leaveForNoticeIfTenantDeleted(answer(body), leave)).resolves.toBe(false);
		expect(leave).not.toHaveBeenCalled();
	});
});
