// @vitest-environment jsdom

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { adminFetch, buildAdminHeaders } from './admin-request';
import { settingsContext } from '$lib/stores/settings-context.svelte';

describe('buildAdminHeaders', () => {
	beforeEach(() => {
		localStorage.clear();
		sessionStorage.clear();
		settingsContext.reset();
		vi.restoreAllMocks();
	});

	it('uses the persisted tenant selection when store initialization has not completed yet', () => {
		sessionStorage.setItem('settings_tenant_id', 'first');
		localStorage.setItem('sessionId', 'session-123');

		const headers = buildAdminHeaders();

		expect(headers.get('X-Tenant-Id')).toBe('first');
		expect(headers.get('X-Session-Id')).toBeNull();
	});

	it('prefers the live tenant context over a stale persisted selection', async () => {
		await settingsContext.setTenantId('fresh');
		sessionStorage.setItem('settings_tenant_id', 'stale');

		const headers = buildAdminHeaders();

		expect(headers.get('X-Tenant-Id')).toBe('fresh');
	});

	it('uses an explicit tenant override for tenant path admin API calls', async () => {
		await settingsContext.setTenantId('first');

		const headers = buildAdminHeaders(undefined, { tenantId: 'second' });

		expect(headers.get('X-Tenant-Id')).toBe('second');
	});

	it('omits X-Tenant-Id before any tenant context is available', () => {
		const headers = buildAdminHeaders();

		expect(headers.get('X-Tenant-Id')).toBeNull();
	});

	it('omits X-Tenant-Id when skipTenantHeader is enabled', () => {
		sessionStorage.setItem('settings_tenant_id', 'first');

		const headers = buildAdminHeaders(undefined, { skipTenantHeader: true });

		expect(headers.get('X-Tenant-Id')).toBeNull();
	});

	it('does not add Idempotency-Key to safe requests', () => {
		const headers = buildAdminHeaders(undefined, { method: 'GET' });

		expect(headers.get('Idempotency-Key')).toBeNull();
	});

	it('adds Idempotency-Key to mutation requests', () => {
		const headers = buildAdminHeaders(undefined, { method: 'POST' });

		expect(headers.get('Idempotency-Key')).toEqual(expect.any(String));
	});

	it('keeps an explicit Idempotency-Key for mutation requests', () => {
		const headers = buildAdminHeaders({ 'Idempotency-Key': 'explicit-key' }, { method: 'POST' });

		expect(headers.get('Idempotency-Key')).toBe('explicit-key');
	});

	it('passes Idempotency-Key through adminFetch for mutation requests', async () => {
		const fetchMock = vi.fn().mockResolvedValue(
			new Response(JSON.stringify({ ok: true }), {
				status: 200,
				headers: { 'Content-Type': 'application/json' }
			})
		);
		vi.stubGlobal('fetch', fetchMock);

		await adminFetch('/api/admin/example', {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({ ok: true })
		});

		const headers = fetchMock.mock.calls[0]?.[1]?.headers;
		expect(headers).toBeInstanceOf(Headers);
		expect((headers as Headers).get('Idempotency-Key')).toEqual(expect.any(String));
	});

	it('replays a write-fenced mutation with the same idempotency key', async () => {
		vi.useFakeTimers();
		try {
			const fetchMock = vi
				.fn()
				.mockResolvedValueOnce(
					new Response(
						JSON.stringify({
							error: 'temporarily_unavailable',
							extensions: {
								reason: 'tenant_placement_write_fence',
								retryable: true,
								retry_after_ms: 250
							}
						}),
						{ status: 503, headers: { 'Content-Type': 'application/json' } }
					)
				)
				.mockResolvedValueOnce(new Response(JSON.stringify({ ok: true }), { status: 200 }));
			vi.stubGlobal('fetch', fetchMock);

			const pending = adminFetch('/api/admin/example', {
				method: 'POST',
				body: JSON.stringify({ mutation: true })
			});
			await vi.advanceTimersByTimeAsync(250);
			await expect(pending).resolves.toMatchObject({ status: 200 });

			expect(fetchMock).toHaveBeenCalledTimes(2);
			const first = fetchMock.mock.calls[0]?.[1] as RequestInit;
			const second = fetchMock.mock.calls[1]?.[1] as RequestInit;
			expect(second.body).toBe(first.body);
			expect((second.headers as Headers).get('Idempotency-Key')).toBe(
				(first.headers as Headers).get('Idempotency-Key')
			);
		} finally {
			vi.useRealTimers();
		}
	});
});
