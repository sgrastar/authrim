import { afterEach, describe, expect, it, vi } from 'vitest';
import { httpIpAllowlist, ipAllowlistEntryFromRow, isLockoutRefusal } from './admin-ip-allowlist';
import { ApiError } from './api-error';
import { fakeIpAllowlist } from './fake/admin-ip-allowlist-fake';

afterEach(() => vi.unstubAllGlobals());

const json = (body: unknown, status = 200) =>
	new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

const call = (fetchMock: ReturnType<typeof vi.fn>, index = 0) =>
	fetchMock.mock.calls[index] as unknown as [string, RequestInit];

describe('an entry from the wire', () => {
	it('reads the flag and the version, whichever way the API writes them', () => {
		expect(
			ipAllowlistEntryFromRow({ id: 'a', ip_range: '10.0.0.0/8', ip_version: 4, enabled: 1 })
		).toMatchObject({ enabled: true, ip_version: 4, description: null });
		expect(
			ipAllowlistEntryFromRow({ id: 'b', ip_range: '2001:db8::/32', enabled: false })
		).toMatchObject({
			enabled: false,
			ip_version: 6
		});
		expect(
			ipAllowlistEntryFromRow({ id: 'c', ip_range: '1.2.3.4', description: '' }).description
		).toBeNull();
	});
});

describe('requests', () => {
	it('lists every entry, disabled ones too, and reads the address of the caller', async () => {
		const fetchMock = vi.fn(async () =>
			json({
				items: [{ id: 'a', ip_range: '203.0.113.0/24', ip_version: 4, enabled: true }],
				current_ip: '203.0.113.5, 10.0.0.1',
				restriction_active: true
			})
		);
		vi.stubGlobal('fetch', fetchMock);
		const list = await httpIpAllowlist('acme').list();
		const [url, init] = call(fetchMock);
		expect(url).toBe('/api/admin/ip-allowlist?include_disabled=true');
		expect(new Headers(init.headers).get('X-Tenant-Id')).toBe('acme');
		expect(list.currentIp).toBe('203.0.113.5');
		expect(list.entries).toHaveLength(1);
	});

	it('has no address when the API could not tell', async () => {
		vi.stubGlobal(
			'fetch',
			vi.fn(async () => json({ items: [], current_ip: 'unknown' }))
		);
		expect((await httpIpAllowlist('acme').list()).currentIp).toBeNull();
	});

	it('adds an entry and leaves an empty description out', async () => {
		const fetchMock = vi.fn(async () => json({ id: 'n', ip_range: '1.2.3.4', enabled: true }, 201));
		vi.stubGlobal('fetch', fetchMock);
		await httpIpAllowlist('acme').create({ ip_range: ' 1.2.3.4 ', description: '  ' });
		const [url, init] = call(fetchMock);
		expect(url).toBe('/api/admin/ip-allowlist');
		expect(init.method).toBe('POST');
		expect(JSON.parse(init.body as string)).toEqual({ ip_range: '1.2.3.4' });
	});

	it('changes only what was given, and clears a description with an empty one', async () => {
		const fetchMock = vi.fn(async () => json({ id: 'a', ip_range: '1.2.3.4', enabled: true }));
		vi.stubGlobal('fetch', fetchMock);
		await httpIpAllowlist('acme').update('a b', { description: ' ' });
		const [url, init] = call(fetchMock);
		expect(url).toBe('/api/admin/ip-allowlist/a%20b');
		expect(init.method).toBe('PATCH');
		expect(JSON.parse(init.body as string)).toEqual({ description: '' });
	});

	it('switches an entry on and off, and deletes it', async () => {
		const fetchMock = vi.fn(async () => json({ success: true }));
		vi.stubGlobal('fetch', fetchMock);
		const client = httpIpAllowlist('acme');
		await client.setEnabled('a', true);
		await client.setEnabled('a', false);
		await client.remove('a');
		expect(call(fetchMock, 0)).toEqual([
			'/api/admin/ip-allowlist/a/enable',
			expect.objectContaining({ method: 'POST' })
		]);
		expect(call(fetchMock, 1)[0]).toBe('/api/admin/ip-allowlist/a/disable');
		expect(call(fetchMock, 2)).toEqual([
			'/api/admin/ip-allowlist/a',
			expect.objectContaining({ method: 'DELETE' })
		]);
	});

	it('hands a refusal on as an error with its status', async () => {
		vi.stubGlobal(
			'fetch',
			vi.fn(async () => json({ error: 'forbidden' }, 403))
		);
		await expect(httpIpAllowlist('acme').list()).rejects.toMatchObject({ status: 403 });
		vi.stubGlobal(
			'fetch',
			vi.fn(async () => json({ error: 'conflict' }, 409))
		);
		await expect(
			httpIpAllowlist('acme').create({ ip_range: '1.2.3.4', description: '' })
		).rejects.toBeInstanceOf(ApiError);
	});
});

describe('going on with a change that would lock the caller out', () => {
	it('asks for it on every kind of change, and only when told to', async () => {
		const fetchMock = vi.fn(async () => json({ id: 'a', ip_range: '1.2.3.4', enabled: true }));
		vi.stubGlobal('fetch', fetchMock);
		const client = httpIpAllowlist('acme');
		await client.create({ ip_range: '1.2.3.4', description: '' }, { allowLockout: true });
		await client.update('a', { ip_range: '1.2.3.5' }, { allowLockout: true });
		await client.setEnabled('a', false, { allowLockout: true });
		await client.remove('a', { allowLockout: true });
		await client.remove('a', { allowLockout: false });
		await client.remove('a');
		const urls = fetchMock.mock.calls.map((entry) => (entry as unknown as [string])[0]);
		expect(urls).toEqual([
			'/api/admin/ip-allowlist?allow_lockout=true',
			'/api/admin/ip-allowlist/a?allow_lockout=true',
			'/api/admin/ip-allowlist/a/disable?allow_lockout=true',
			'/api/admin/ip-allowlist/a?allow_lockout=true',
			'/api/admin/ip-allowlist/a',
			'/api/admin/ip-allowlist/a'
		]);
	});

	it('tells a lock-out refusal from another conflict', async () => {
		vi.stubGlobal(
			'fetch',
			vi.fn(async () => json({ error: 'would_lock_out', current_ip: '203.0.113.5' }, 409))
		);
		const failure = await httpIpAllowlist('acme')
			.remove('a')
			.catch((error: unknown) => error);
		expect(isLockoutRefusal(failure)).toBe(true);
		vi.stubGlobal(
			'fetch',
			vi.fn(async () => json({ error_code: 'conflict' }, 409))
		);
		const other = await httpIpAllowlist('acme')
			.remove('a')
			.catch((error: unknown) => error);
		expect(isLockoutRefusal(other)).toBe(false);
		expect(isLockoutRefusal(new Error('x'))).toBe(false);
	});
});

describe('the fake follows the API', () => {
	it('refuses a range already listed and one that is not an address', async () => {
		const fake = fakeIpAllowlist();
		await expect(
			fake.create({ ip_range: '203.0.113.0/24', description: '' })
		).rejects.toMatchObject({ status: 409 });
		await expect(fake.create({ ip_range: 'nope', description: '' })).rejects.toMatchObject({
			status: 400
		});
	});

	it('adds, switches off and deletes', async () => {
		const fake = fakeIpAllowlist({ entries: [] });
		const made = await fake.create({ ip_range: '10.0.0.1', description: 'x' });
		await fake.setEnabled(made.id, false);
		expect(fake.entries()[0]).toMatchObject({
			ip_range: '10.0.0.1',
			enabled: false,
			description: 'x'
		});
		await fake.remove(made.id);
		expect(fake.entries()).toEqual([]);
	});
});
