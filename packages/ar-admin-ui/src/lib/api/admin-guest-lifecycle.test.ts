import { beforeEach, expect, it, vi } from 'vitest';
const fetch = vi.hoisted(() => vi.fn());
vi.mock('./admin-request', () => ({ API_BASE_URL: '', adminFetch: fetch }));
import { listGuestLifecycle } from './admin-guest-lifecycle';
beforeEach(() => vi.clearAllMocks());
it('uses tenant-scoped read requests and opaque continuation cursors', async () => {
	const page = { items: [], next_cursor: null, observed_at: 123 };
	fetch.mockResolvedValue(Response.json(page));
	expect(await listGuestLifecycle('tenant-a', 'opaque+cursor')).toEqual(page);
	expect(fetch).toHaveBeenCalledWith(
		'/api/admin/account-lifecycle/guests?limit=100&cursor=opaque%2Bcursor',
		{ tenantId: 'tenant-a' }
	);
});
it('does not present an unavailable page as an empty successful result', async () => {
	fetch.mockResolvedValue(new Response(null, { status: 503 }));
	await expect(listGuestLifecycle('tenant-a')).rejects.toThrow('lifecycle_inspection_unavailable');
});
