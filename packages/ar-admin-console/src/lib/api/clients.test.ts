import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
const steps = vi.hoisted(() => ({
	reauthenticate: vi.fn(async () => {}),
	verifySecondFactor: vi.fn(async () => {}),
	issueReceipt: vi.fn(async () => 'asp_receipt')
}));
const scope = vi.hoisted(() => ({ tenantId: 'tenant-a' }));
vi.mock('#lib/auth/tenant-scope.svelte.js', () => ({ tenantScope: scope }));
vi.mock('./admin-step-up', async (original) => {
	const actual = await original<typeof import('./admin-step-up')>();
	return {
		...actual,
		withStepUp: <T>(operation: (receipt?: string) => Promise<T>) =>
			actual.withStepUp(operation, steps)
	};
});
import { httpClients } from './clients';
import { restoreIdentityMappingLevel } from './identity-mapping';
import { StepUpCancelledError } from './admin-step-up';
const row = {
	client_id: 'app',
	client_name: 'App',
	redirect_uris: [],
	enabled: false,
	enable_blockers: ['redirect_uris'],
	updated_at: 1000
};
const refusal = () =>
	Response.json(
		{ error: 'step_up_required', step_up_id: 'asr_request', missing: [] },
		{ status: 403 }
	);
beforeEach(() => {
	scope.tenantId = 'tenant-a';
	vi.clearAllMocks();
	steps.issueReceipt.mockResolvedValue('asp_receipt');
});
afterEach(() => vi.unstubAllGlobals());
describe('client writes with step-up', () => {
	it.each(['create', 'update', 'enable', 'mapping'] as const)(
		'freezes body, tenant and idempotency key for %s retries',
		async (operation) => {
			const writes: RequestInit[] = [];
			vi.stubGlobal(
				'fetch',
				vi.fn(async (_url: string, init: RequestInit) => {
					if (!init.method || init.method === 'GET') return Response.json({ client: row });
					writes.push(init);
					return writes.length === 1
						? refusal()
						: Response.json({
								client: { ...row, enabled: true, enable_blockers: [], updated_at: 1001 }
							});
				})
			);
			if (operation === 'create')
				await httpClients.create({
					enabled: false,
					client_name: 'App',
					application_type: 'web',
					redirect_uris: [],
					grant_types: ['authorization_code'],
					response_types: ['code'],
					scope: 'openid',
					token_endpoint_auth_method: 'client_secret_basic',
					require_pkce: true
				});
			if (operation === 'update')
				await httpClients.updateBasics('app', {
					client_name: 'Changed',
					expected_updated_at: 1000
				});
			if (operation === 'enable') await httpClients.setEnabled('app', true, 1000);
			if (operation === 'mapping') await httpClients.bindMapping('app', 'mapping-a');
			expect(writes).toHaveLength(2);
			expect(writes[1].body).toBe(writes[0].body);
			const before = new Headers(writes[0].headers);
			const after = new Headers(writes[1].headers);
			expect(after.get('Idempotency-Key')).toBe(before.get('Idempotency-Key'));
			expect(after.get('authrim-step-up-receipt')).toBe('asp_receipt');
			expect(after.get('X-Tenant-Id')).toBe('tenant-a');
			if (operation === 'mapping')
				expect(JSON.parse(String(writes[1].body)).expected_updated_at).toBe(1000);
		}
	);
	it('retries a history restore with the same body and operation key', async () => {
		const writes: RequestInit[] = [];
		vi.stubGlobal(
			'fetch',
			vi.fn(async (_url: string, init: RequestInit) => {
				writes.push(init);
				return writes.length === 1 ? refusal() : Response.json({ success: true });
			})
		);
		await restoreIdentityMappingLevel('tenant-a', 'history-a', '1000');
		expect(writes).toHaveLength(2);
		expect(writes[0].body).toBe(writes[1].body);
		expect(JSON.parse(String(writes[1].body))).toEqual({ expected_version: '1000' });
		expect(new Headers(writes[0].headers).get('Idempotency-Key')).toBe(
			new Headers(writes[1].headers).get('Idempotency-Key')
		);
		expect(new Headers(writes[1].headers).get('authrim-step-up-receipt')).toBe('asp_receipt');
	});

	it('cancels instead of retrying after the tenant changes during authentication', async () => {
		const fetcher = vi.fn(async () => refusal());
		vi.stubGlobal('fetch', fetcher);
		steps.issueReceipt.mockImplementationOnce(async () => {
			scope.tenantId = 'tenant-b';
			return 'asp_receipt';
		});
		await expect(httpClients.setEnabled('app', true, 1000)).rejects.toBeInstanceOf(
			StepUpCancelledError
		);
		expect(fetcher).toHaveBeenCalledTimes(1);
	});
	it('projects lifecycle state and missing fields from the authoritative detail response', async () => {
		vi.stubGlobal(
			'fetch',
			vi.fn(async () => Response.json({ client: row }))
		);
		expect(await httpClients.get('app')).toMatchObject({
			enabled: false,
			enableBlockers: ['redirect_uris'],
			updatedAt: 1000
		});
	});
});
