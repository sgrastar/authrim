import { afterEach, describe, expect, it, vi } from 'vitest';
import { adminTokenExchangeSettingsAPI } from './admin-settings';

describe('adminTokenExchangeSettingsAPI', () => {
	afterEach(() => {
		vi.restoreAllMocks();
	});

	it('loads token exchange config from the dedicated endpoint', async () => {
		const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
			new Response(
				JSON.stringify({ settings: { enabled: { value: true, source: 'kv', default: false } } }),
				{
					status: 200,
					headers: { 'Content-Type': 'application/json' }
				}
			)
		);

		const result = await adminTokenExchangeSettingsAPI.getConfig();

		expect(result.settings.enabled.value).toBe(true);
		expect(fetchMock).toHaveBeenCalledWith(
			expect.stringContaining('/api/admin/settings/token-exchange'),
			expect.objectContaining({
				headers: expect.any(Headers)
			})
		);
	});

	it('updates token exchange config through the dedicated endpoint', async () => {
		const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
			new Response(
				JSON.stringify({ settings: { enabled: { value: true, source: 'kv', default: false } } }),
				{
					status: 200,
					headers: { 'Content-Type': 'application/json' }
				}
			)
		);

		await adminTokenExchangeSettingsAPI.updateConfig({ enabled: true });

		expect(fetchMock).toHaveBeenCalledWith(
			expect.stringContaining('/api/admin/settings/token-exchange'),
			expect.objectContaining({
				method: 'PUT',
				body: JSON.stringify({ enabled: true })
			})
		);
	});
});
