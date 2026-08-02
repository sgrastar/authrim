import { afterEach, describe, expect, it, vi } from 'vitest';
import { adminPluginsAPI } from './admin-plugins';

describe('adminPluginsAPI', () => {
	afterEach(() => {
		vi.restoreAllMocks();
	});

	it('keeps managed provisioning implicit when enabling a plugin', async () => {
		const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
			new Response(
				JSON.stringify({
					pluginId: 'plugin-a',
					enabled: true,
					configSource: 'default',
					configured: true,
					missingRequiredFields: []
				}),
				{ status: 200, headers: { 'Content-Type': 'application/json' } }
			)
		);

		await adminPluginsAPI.enable('plugin-a', 'tenant-a');

		expect(fetchMock).toHaveBeenCalledWith(
			expect.stringContaining('/api/admin/plugins/plugin-a/enable'),
			expect.objectContaining({
				method: 'PUT',
				body: JSON.stringify({ tenant_id: 'tenant-a' })
			})
		);
	});

	it('serializes an advanced existing-resource selection without putting it in the URL', async () => {
		const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
			new Response(
				JSON.stringify({
					pluginId: 'plugin-a',
					enabled: true,
					configSource: 'default',
					configured: true,
					missingRequiredFields: []
				}),
				{ status: 200, headers: { 'Content-Type': 'application/json' } }
			)
		);

		await adminPluginsAPI.enable('plugin-a', 'tenant-a', [
			{
				logicalResourceId: 'plugin_cache',
				mode: 'existing',
				providerResourceId: 'resource-a',
				providerName: 'existing-cache'
			}
		]);

		const [url, init] = fetchMock.mock.calls[0] ?? [];
		expect(String(url)).not.toContain('resource-a');
		expect(init).toEqual(
			expect.objectContaining({
				method: 'PUT',
				body: JSON.stringify({
					tenant_id: 'tenant-a',
					resource_selections: [
						{
							logical_resource_id: 'plugin_cache',
							mode: 'existing',
							provider_resource_id: 'resource-a',
							provider_name: 'existing-cache'
						}
					]
				})
			})
		);
	});

	it('sends an explicit tenant-scoped confirmation for managed-resource uninstall', async () => {
		const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
			new Response(JSON.stringify({ success: true, enabled: false, cleanup: null }), {
				status: 200,
				headers: { 'Content-Type': 'application/json' }
			})
		);

		await adminPluginsAPI.uninstall('plugin-a', 'tenant-a', 'uninstall-a');

		expect(fetchMock).toHaveBeenCalledWith(
			expect.stringContaining('/api/admin/plugins/plugin-a/uninstall'),
			expect.objectContaining({
				method: 'POST',
				body: JSON.stringify({
					tenant_id: 'tenant-a',
					idempotency_key: 'uninstall-a',
					confirmation: 'UNINSTALL'
				})
			})
		);
	});
});
