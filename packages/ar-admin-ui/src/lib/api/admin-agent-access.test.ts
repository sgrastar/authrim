// @vitest-environment jsdom

import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
	adminAgentAccessAPI,
	buildAgentAccessMcpUrl,
	type AgentAccessSettings
} from './admin-agent-access';
import { API_BASE_URL } from './admin-request';
import { settingsContext } from '$lib/stores/settings-context.svelte';

function adminUrl(path: string): string {
	return `${API_BASE_URL}${path}`;
}

function jsonResponse(body: unknown, status = 200): Response {
	return new Response(JSON.stringify(body), {
		status,
		headers: { 'Content-Type': 'application/json' }
	});
}

describe('adminAgentAccessAPI', () => {
	beforeEach(async () => {
		localStorage.clear();
		sessionStorage.clear();
		settingsContext.reset();
		await settingsContext.setTenantId('tenant-a');
		vi.restoreAllMocks();
	});

	it('builds the connection URL from the tenant issuer instead of the Admin UI origin', () => {
		expect(buildAgentAccessMcpUrl('https://first.test.authrim.com/')).toBe(
			'https://first.test.authrim.com/mcp'
		);
		expect(buildAgentAccessMcpUrl('https://issuer.example/tenant?ignored=1#ignored')).toBe(
			'https://issuer.example/tenant/mcp'
		);
	});

	it('creates a read-only Agent Grant using the tenant-aware Admin request path', async () => {
		const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ grant_id: 'aag_1' }, 201));
		vi.stubGlobal('fetch', fetchMock);

		await expect(
			adminAgentAccessAPI.createGrant({
				client_id: 'client-a',
				delegator_id: 'admin-a',
				task_set_id: 'builtin:read-only-inspector',
				task_set_version: 1,
				scope_policy_id: 'asp_read-only',
				scope_policy_version: 1
			})
		).resolves.toEqual({ grant_id: 'aag_1' });

		const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
		expect(url).toBe(adminUrl('/api/admin/agent-grants'));
		expect(init.method).toBe('POST');
		expect((init.headers as Headers).get('X-Tenant-Id')).toBe('tenant-a');
		expect(JSON.parse(String(init.body))).toEqual({
			client_id: 'client-a',
			delegator_id: 'admin-a',
			task_set_id: 'builtin:read-only-inspector',
			task_set_version: 1,
			scope_policy_id: 'asp_read-only',
			scope_policy_version: 1
		});
	});

	it('uses fixed grant transition paths and never accepts a caller-supplied route', async () => {
		const fetchMock = vi
			.fn()
			.mockResolvedValue(jsonResponse({ grant_id: 'aag_1', status: 'suspended', generation: 2 }));
		vi.stubGlobal('fetch', fetchMock);

		await adminAgentAccessAPI.suspendGrant('aag_1');

		expect(fetchMock.mock.calls[0]?.[0]).toBe(adminUrl('/api/admin/agent-grants/aag_1/suspend'));
		expect(fetchMock.mock.calls[0]?.[1]?.method).toBe('POST');
	});

	it('loads and decides an encoded operation-bound elevation challenge', async () => {
		const fetchMock = vi
			.fn()
			.mockResolvedValueOnce(jsonResponse({ elevation: { id: 'ael_/1', status: 'pending' } }))
			.mockResolvedValueOnce(jsonResponse({ id: 'ael_/1', status: 'approved' }));
		vi.stubGlobal('fetch', fetchMock);

		await adminAgentAccessAPI.getElevation('ael_/1');
		await adminAgentAccessAPI.decideElevation('ael_/1', 'approved');

		expect(fetchMock.mock.calls[0]?.[0]).toBe(adminUrl('/api/admin/agent-elevations/ael_%2F1'));
		expect(fetchMock.mock.calls[1]?.[0]).toBe(
			adminUrl('/api/admin/agent-elevations/ael_%2F1/decision')
		);
		expect(fetchMock.mock.calls[1]?.[1]?.method).toBe('POST');
		expect(JSON.parse(String(fetchMock.mock.calls[1]?.[1]?.body))).toEqual({
			decision: 'approved'
		});
	});

	it('encodes selected participants when resolving eligible permissions', async () => {
		const fetchMock = vi.fn().mockResolvedValue(
			jsonResponse({
				delegator_id: 'admin-a',
				principal_id: 'amp-a',
				permissions: ['admin:users:read']
			})
		);
		vi.stubGlobal('fetch', fetchMock);

		await adminAgentAccessAPI.getEligiblePermissions('admin-a', 'amp-a');

		expect(fetchMock.mock.calls[0]?.[0]).toBe(
			adminUrl(
				'/api/admin/agent-grants/eligible-permissions?delegator_id=admin-a&principal_id=amp-a'
			)
		);
		expect(fetchMock.mock.calls[0]?.[1]?.method).toBeUndefined();
	});

	it('sends the complete settings contract on update', async () => {
		const settings: AgentAccessSettings = {
			enabled: true,
			maxTokenTtlSeconds: 600,
			elevationMode: 'self_reauth',
			elevationTtlSeconds: 180,
			requestRateLimitPerMinute: 600,
			sessionInitializationRateLimitPerMinute: 30,
			maxConcurrentSessions: 20,
			rateLimitPerMinute: 60,
			publicClientStandardRateLimitPerMinute: 10,
			highRiskPermissionsAdditional: [],
			publicClientStandardToolIds: [],
			bulkCanaryProtected: false
		};
		const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ settings }));
		vi.stubGlobal('fetch', fetchMock);

		await expect(adminAgentAccessAPI.updateSettings(settings)).resolves.toEqual(settings);

		expect(fetchMock.mock.calls[0]?.[0]).toBe(adminUrl('/api/admin/settings/agent'));
		expect(fetchMock.mock.calls[0]?.[1]?.method).toBe('PUT');
		expect(JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body))).toEqual(settings);
	});

	it('binds overview reads and writes to an explicit tenant during a context switch', async () => {
		const settings: AgentAccessSettings = {
			enabled: false,
			maxTokenTtlSeconds: 600,
			elevationMode: 'self_reauth',
			elevationTtlSeconds: 180,
			requestRateLimitPerMinute: 600,
			sessionInitializationRateLimitPerMinute: 30,
			maxConcurrentSessions: 20,
			rateLimitPerMinute: 60,
			publicClientStandardRateLimitPerMinute: 10,
			highRiskPermissionsAdditional: [],
			publicClientStandardToolIds: [],
			bulkCanaryProtected: false
		};
		const fetchMock = vi
			.fn()
			.mockResolvedValueOnce(jsonResponse({ settings }))
			.mockResolvedValueOnce(jsonResponse({ settings: { ...settings, enabled: true } }));
		vi.stubGlobal('fetch', fetchMock);

		await settingsContext.setTenantId('tenant-c');
		await adminAgentAccessAPI.getSettings('tenant-b');
		await adminAgentAccessAPI.updateSettings({ ...settings, enabled: true }, 'tenant-b');

		for (const call of fetchMock.mock.calls) {
			expect((call[1]?.headers as Headers).get('X-Tenant-Id')).toBe('tenant-b');
		}
	});

	it('binds Grant detail reads and mutations to the explicitly loaded tenant', async () => {
		const fetchMock = vi
			.fn()
			.mockResolvedValueOnce(jsonResponse({ grant: { id: 'aag-1' } }))
			.mockResolvedValueOnce(jsonResponse({ events: [] }))
			.mockResolvedValueOnce(jsonResponse({}))
			.mockResolvedValueOnce(jsonResponse({}))
			.mockResolvedValueOnce(jsonResponse({}));
		vi.stubGlobal('fetch', fetchMock);

		await settingsContext.setTenantId('tenant-c');
		await adminAgentAccessAPI.getGrant('aag-1', 'tenant-b');
		await adminAgentAccessAPI.listGrantAudit('aag-1', 'tenant-b');
		await adminAgentAccessAPI.updateGrant('aag-1', { purpose: 'test' }, 'tenant-b');
		await adminAgentAccessAPI.preauthorizeGrant('aag-1', 'tenant-b');
		await adminAgentAccessAPI.suspendGrant('aag-1', 'tenant-b');

		for (const call of fetchMock.mock.calls) {
			expect((call[1]?.headers as Headers).get('X-Tenant-Id')).toBe('tenant-b');
		}
	});

	it('binds Bulk Plan creation to an explicit machine credential and immutable targets', async () => {
		const fetchMock = vi
			.fn()
			.mockResolvedValue(
				jsonResponse({ id: 'bulk-1', version: 1, digest: 'digest-1', status: 'draft' }, 201)
			);
		vi.stubGlobal('fetch', fetchMock);
		await adminAgentAccessAPI.createBulkPlan({
			grant_id: 'grant-1',
			machine_credential_id: 'credential-1',
			definition: {
				schemaVersion: 'authrim-agent-bulk-plan-v1',
				targetTenantIds: ['tenant-a'],
				canaryTenantIds: ['tenant-a'],
				plan: { schemaVersion: 'authrim-agent-plan-v1', steps: [] }
			}
		});
		const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
		expect(url).toBe(adminUrl('/api/admin/agent-bulk-plans'));
		expect(JSON.parse(String(init.body))).toMatchObject({
			grant_id: 'grant-1',
			machine_credential_id: 'credential-1',
			definition: { targetTenantIds: ['tenant-a'], canaryTenantIds: ['tenant-a'] }
		});
	});

	it('evaluates Baseline drift without accepting caller-supplied current state', async () => {
		const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ drift_status: 'in_sync' }));
		vi.stubGlobal('fetch', fetchMock);
		await adminAgentAccessAPI.evaluateBaselineAssignment('assignment-1');
		const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
		expect(url).toBe(adminUrl('/api/admin/agent-baselines/assignments/assignment-1/evaluate'));
		expect(init.method).toBe('POST');
		expect(init.body).toBeUndefined();
	});

	it('surfaces stable server error descriptions', async () => {
		vi.stubGlobal(
			'fetch',
			vi
				.fn()
				.mockResolvedValue(
					jsonResponse(
						{ error: 'AGENT_MCP_DISABLED', error_description: 'AGENT_MCP_DISABLED' },
						404
					)
				)
		);

		await expect(adminAgentAccessAPI.getSettings()).rejects.toThrow('AGENT_MCP_DISABLED');
	});
});
