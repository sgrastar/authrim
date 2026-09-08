import { beforeEach, describe, expect, it, vi } from 'vitest';
const { request } = vi.hoisted(() => ({ request: vi.fn() }));
vi.mock('./admin-request', () => ({ API_BASE_URL: '', adminFetch: request }));
import { adminClientGuestAPI, defaultClientGuestPolicy } from './admin-client-guest';
describe('client guest policy API', () => {
	beforeEach(() => vi.resetAllMocks());
	it('uses disabled defaults only for an absent profile, not a failed read', async () => {
		request.mockResolvedValueOnce(new Response(null, { status: 404 }));
		expect(await adminClientGuestAPI.get('client', 'tenant')).toMatchObject({
			version: 0,
			policy: { enabled: false, allowedScopes: ['openid', 'account:lifecycle:read'] }
		});
		request.mockResolvedValueOnce(new Response(null, { status: 503 }));
		await expect(adminClientGuestAPI.get('client', 'tenant')).rejects.toThrow(
			'guest_policy_load_failed'
		);
	});
	it('preserves existing policy fields while enforcing same-sub upgrade', async () => {
		request.mockResolvedValueOnce(
			Response.json({
				profile: {
					version: 4,
					anonymousAuth: {
						enabled: true,
						preserveSubOnUpgrade: false,
						allowedScopes: ['openid'],
						deviceStability: 'session'
					}
				}
			})
		);
		expect(await adminClientGuestAPI.get('client', 'tenant')).toMatchObject({
			version: 4,
			policy: {
				enabled: true,
				preserveSubOnUpgrade: true,
				allowedScopes: ['openid'],
				deviceStability: 'session'
			}
		});
	});
	it('sends the selected tenant, profile revision, and only the guest policy', async () => {
		request.mockResolvedValueOnce(new Response(null, { status: 204 }));
		await adminClientGuestAPI.save('client/1', 'tenant', 4, defaultClientGuestPolicy());
		expect(request).toHaveBeenCalledWith(
			'/api/admin/clients/client%2F1/profile',
			expect.objectContaining({
				method: 'PUT',
				tenantId: 'tenant',
				body: JSON.stringify({
					ifMatch: '4',
					profile: { anonymousAuth: defaultClientGuestPolicy() }
				})
			})
		);
	});
	it.each([
		[409, 'guest_policy_conflict'],
		[412, 'guest_policy_tenant_required'],
		[403, 'guest_policy_save_failed']
	])('reports save failure %s', async (status, message) => {
		request.mockResolvedValueOnce(new Response(null, { status: Number(status) }));
		await expect(
			adminClientGuestAPI.save('client', 'tenant', 1, defaultClientGuestPolicy())
		).rejects.toThrow(String(message));
	});
});
