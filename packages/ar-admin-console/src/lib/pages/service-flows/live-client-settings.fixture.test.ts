import { describe, expect, it, vi } from 'vitest';
import { ApiError } from '#lib/api/api-error.js';
import { StepUpCancelledError } from '#lib/api/admin-step-up.js';
import { liveClientSettingsFixture } from './live-client-settings.fixture';

describe('live client story state', () => {
	it('restores the name, blockers and version after a prior story edits a draft', async () => {
		const fixture = liveClientSettingsFixture({ redirects: [] });
		await fixture.client.updateBasics('portal', {
			client_name: 'Callback later',
			redirect_uris: ['https://portal.example.test/later'],
			expected_updated_at: 1000
		});
		expect(await fixture.client.get('portal')).toMatchObject({
			name: 'Callback later',
			enableBlockers: [],
			updatedAt: 1001
		});
		fixture.reset();
		expect(await fixture.client.get('portal')).toMatchObject({
			name: 'Staff portal',
			enabled: false,
			redirectUris: [],
			enableBlockers: ['redirect_uris'],
			updatedAt: 1000
		});
	});

	it('keeps activation cancellation after mocks are reset', async () => {
		const fixture = liveClientSettingsFixture({ activationCancelled: true });
		const update = vi.fn(fixture.client.setEnabled);
		update.mockReset();
		await expect(update('portal', true, 1000)).rejects.toBeInstanceOf(StepUpCancelledError);
		expect(await fixture.client.get('portal')).toMatchObject({ enabled: false, updatedAt: 1000 });
	});

	it('keeps callback refusal after mocks are reset without committing the rejected edit', async () => {
		const fixture = liveClientSettingsFixture({ enabled: true, refuseMissingCallbacks: true });
		const update = vi.fn(fixture.client.updateBasics);
		update.mockReset();
		await expect(
			update('portal', { redirect_uris: [], expected_updated_at: 1000 })
		).rejects.toMatchObject({
			status: 400,
			code: 'client_configuration_required_to_enable',
			body: { missing: ['redirect_uris'] }
		});
		expect(await fixture.client.get('portal')).toMatchObject({
			enabled: true,
			redirectUris: ['https://portal.example.test/callback'],
			enableBlockers: [],
			updatedAt: 1000
		});
	});

	it('returns the saved status and version for the next activation change', async () => {
		const fixture = liveClientSettingsFixture();
		expect(await fixture.client.setEnabled('portal', true, 1000)).toMatchObject({
			enabled: true,
			enableBlockers: [],
			updatedAt: 1001
		});
		expect(await fixture.client.setEnabled('portal', false, 1001)).toMatchObject({
			enabled: false,
			enableBlockers: [],
			updatedAt: 1002
		});
		await expect(fixture.client.setEnabled('portal', true, 1000)).rejects.toBeInstanceOf(ApiError);
	});

	it('refuses activation until the returned blockers are cleared', async () => {
		const fixture = liveClientSettingsFixture({ redirects: [] });
		await expect(fixture.client.setEnabled('portal', true, 1000)).rejects.toMatchObject({
			status: 400,
			body: { missing: ['redirect_uris'] }
		});
		const saved = await fixture.client.updateBasics('portal', {
			redirect_uris: ['https://portal.example.test/callback'],
			expected_updated_at: 1000
		});
		expect(saved).toMatchObject({ enableBlockers: [], updatedAt: 1001 });
		expect(await fixture.client.setEnabled('portal', true, 1001)).toMatchObject({
			enabled: true,
			updatedAt: 1002
		});
	});

	it('derives key and PKCE blockers from the saved values', async () => {
		const fixture = liveClientSettingsFixture({ auth: 'private_key_jwt' });
		expect(
			await fixture.client.updateBasics('portal', {
				jwks_uri: null,
				jwks: null,
				expected_updated_at: 1000
			})
		).toMatchObject({ enableBlockers: ['jwks'] });
		const publicClient = liveClientSettingsFixture({ auth: 'none', pkce: true });
		expect(
			await publicClient.client.updateBasics('portal', {
				require_pkce: false,
				expected_updated_at: 1000
			})
		).toMatchObject({ enableBlockers: ['require_pkce'] });
		expect(
			await publicClient.client.updateBasics('portal', {
				require_pkce: true,
				expected_updated_at: 1001
			})
		).toMatchObject({ enableBlockers: [] });
	});
});
