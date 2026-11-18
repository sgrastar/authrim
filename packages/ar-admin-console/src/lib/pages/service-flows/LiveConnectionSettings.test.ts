import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, waitFor } from '@testing-library/svelte';
import { ApiError } from '#lib/api/api-error.js';
import type { ClientDetail, ClientBasicUpdate } from '#lib/api/clients.js';
import { t } from '#lib/i18n/i18n.svelte.js';
import LiveConnectionSettings from './LiveConnectionSettings.svelte';
import LiveConnectionSettingsHarness from './LiveConnectionSettingsHarness.svelte';
import {
	liveClientSettingsFixture,
	type LiveClientFixtureOptions
} from './live-client-settings.fixture';

vi.mock('$app/navigation', () => ({ beforeNavigate: vi.fn(), goto: vi.fn() }));
vi.mock('#lib/auth/tenant-scope.svelte.js', () => ({ tenantScope: { tenantId: '' } }));
// jsdom has no Web Animations API; use the disclosure's reduced-motion path.
beforeEach(() => {
	vi.stubGlobal(
		'ResizeObserver',
		class {
			observe = vi.fn();
			unobserve = vi.fn();
			disconnect = vi.fn();
		}
	);
	vi.stubGlobal(
		'matchMedia',
		vi.fn((media: string) => ({
			matches: media === '(prefers-reduced-motion: reduce)',
			media,
			onchange: null,
			addListener: vi.fn(),
			removeListener: vi.fn(),
			addEventListener: vi.fn(),
			removeEventListener: vi.fn(),
			dispatchEvent: vi.fn(() => true)
		}))
	);
});
afterEach(() => {
	cleanup();
	vi.unstubAllGlobals();
});

function fixture(redirectUris: string[], overrides: Partial<ClientDetail> = {}) {
	let detail: ClientDetail = {
		id: 'portal',
		name: 'Portal',
		enabled: true,
		enableBlockers: [],
		updatedAt: 1000,
		applicationType: 'web',
		authMethod: 'client_secret_basic',
		pkce: false,
		redirectUris,
		advanced: {
			grant_types: redirectUris.length
				? ['authorization_code']
				: ['urn:openid:params:grant-type:ciba'],
			response_types: redirectUris.length ? ['code'] : [],
			backchannel_token_delivery_mode: 'poll'
		},
		...overrides
	};
	const updateBasics = vi.fn(async (_id: string, input: ClientBasicUpdate) => {
		detail = { ...detail, name: input.client_name ?? detail.name, updatedAt: 1001 };
		return detail;
	});
	const view = render(LiveConnectionSettings, {
		resources: {
			kind: 'rp',
			detail,
			client: { get: vi.fn(async () => detail), updateBasics, setEnabled: vi.fn() }
		},
		canEdit: true,
		guardNavigation: false
	});
	return { ...view, updateBasics };
}

describe('live connection completeness', () => {
	it('saves the name of an enabled CIBA client without callbacks', async () => {
		const view = fixture([]);
		await fireEvent.input(view.getByRole('textbox', { name: t('sf.row.name') }), {
			target: { value: 'CIBA renamed' }
		});
		const save = view.getByRole('button', { name: t('common.save') });
		expect(save).toBeEnabled();
		expect(view.queryByText(t('sf.rp.callbacksMissing'))).toBeNull();
		await fireEvent.click(save);
		await waitFor(() =>
			expect(view.updateBasics).toHaveBeenCalledWith('portal', {
				client_name: 'CIBA renamed',
				expected_updated_at: 1000
			})
		);
		await view.findByText(t('sf.live.saved'));
	});

	it.each([
		{ authMethod: 'none', pkce: false, enableBlockers: ['require_pkce'] },
		{ authMethod: 'private_key_jwt', jwks: null, jwksUri: null, enableBlockers: ['jwks'] }
	])(
		'saves a legacy $authMethod client name without completing its settings',
		async (overrides) => {
			const view = fixture(['https://portal.example/callback'], overrides);
			await fireEvent.input(view.getByRole('textbox', { name: t('sf.row.name') }), {
				target: { value: 'Legacy renamed' }
			});
			const save = view.getByRole('button', { name: t('common.save') });
			expect(save).toBeEnabled();
			await fireEvent.click(save);
			await view.findByText(t('sf.live.saved'));
			expect(view.updateBasics).toHaveBeenCalledWith('portal', {
				client_name: 'Legacy renamed',
				expected_updated_at: 1000
			});
		}
	);

	it('keeps malformed JWKS URLs and JSON from being saved', async () => {
		const view = fixture(['https://portal.example/callback'], {
			authMethod: 'private_key_jwt',
			jwksUri: null
		});
		await fireEvent.input(view.getByRole('textbox', { name: t('sf.row.name') }), {
			target: { value: 'Edited' }
		});
		await fireEvent.click(
			view.getByText(t('sf.part.rp-signin'), { selector: '.disclosure__title' })
		);
		const uri = view.getByRole('textbox', { name: t('cs.row.jwksUri') });
		await fireEvent.input(uri, { target: { value: 'http://keys.example/jwks' } });
		const save = view.getByRole('button', { name: t('common.save') });
		expect(save).toBeDisabled();
		await fireEvent.input(uri, { target: { value: '' } });
		expect(save).toBeEnabled();
		await fireEvent.change(view.getByRole('combobox', { name: t('cs.live.keySource') }), {
			target: { value: 'inline' }
		});
		await fireEvent.input(view.getByRole('textbox', { name: t('cs.live.publicJwks') }), {
			target: { value: '{malformed' }
		});
		expect(save).toBeDisabled();
		expect(view.updateBasics).not.toHaveBeenCalled();
	});

	it('lets the server refuse clearing keys on an enabled client', async () => {
		const view = fixture(['https://portal.example/callback'], {
			authMethod: 'private_key_jwt',
			jwksUri: 'https://keys.example/jwks'
		});
		view.updateBasics.mockRejectedValueOnce(
			new ApiError(400, 'client_configuration_required_to_enable', 'Missing jwks', {
				missing: ['jwks']
			})
		);
		await fireEvent.click(
			view.getByText(t('sf.part.rp-signin'), { selector: '.disclosure__title' })
		);
		await fireEvent.input(view.getByRole('textbox', { name: t('cs.row.jwksUri') }), {
			target: { value: '' }
		});
		const save = view.getByRole('button', { name: t('common.save') });
		expect(save).toBeEnabled();
		await fireEvent.click(save);
		await view.findByText(t('common.saveFailed'));
		expect(view.updateBasics).toHaveBeenCalledWith('portal', {
			jwks: null,
			jwks_uri: null,
			expected_updated_at: 1000
		});
	});

	it('lets the server refuse cleared callbacks on an enabled browser client', async () => {
		const view = fixture(['https://portal.example/callback']);
		view.updateBasics.mockRejectedValueOnce(
			new ApiError(400, 'client_configuration_required_to_enable', 'Missing redirect_uris', {
				missing: ['redirect_uris']
			})
		);
		await fireEvent.click(
			view.getByRole('button', {
				name: t('list.remove', { name: 'https://portal.example/callback' })
			})
		);
		const save = view.getByRole('button', { name: t('common.save') });
		expect(save).toBeEnabled();
		await fireEvent.click(save);
		await view.findByText(t('common.saveFailed'));
		expect(view.updateBasics).toHaveBeenCalledWith('portal', {
			redirect_uris: [],
			expected_updated_at: 1000
		});
		expect(view.queryByText(t('sf.live.saved'))).toBeNull();
	});
});

function liveStory(options: LiveClientFixtureOptions = {}) {
	const fixture = liveClientSettingsFixture(options);
	const clients = {
		get: vi.fn(fixture.client.get),
		setEnabled: vi.fn(fixture.client.setEnabled),
		updateBasics: vi.fn(fixture.client.updateBasics)
	};
	const unexpectedSamlCall = async () => {
		throw new Error('Unexpected SAML call');
	};
	const view = render(LiveConnectionSettingsHarness, {
		clients,
		saml: {
			getServiceProvider: unexpectedSamlCall,
			updateServiceProvider: unexpectedSamlCall,
			setEnabled: unexpectedSamlCall
		}
	});
	return { ...view, clients };
}

describe('client activation in the live service flow', () => {
	it('shows step-up cancellation and keeps the client disabled', async () => {
		const view = liveStory({ activationCancelled: true });
		await fireEvent.click(await view.findByRole('button', { name: t('sf.live.enable') }));
		await view.findByText(t('settings.stepUpCancelled'));
		expect(view.getByRole('heading', { name: t('sf.live.status') })).toBeVisible();
		expect(view.clients.setEnabled).toHaveBeenCalledWith('portal', true, 1000);
		expect(view.getByRole('button', { name: t('sf.live.enable') })).toBeEnabled();
	});

	it('shows returned callback blockers and prevents activation', async () => {
		const view = liveStory({ redirects: [] });
		const enable = await view.findByRole('button', { name: t('sf.live.enable') });
		expect(enable).toBeDisabled();
		expect(view.getByText(t('sf.rp.missing.redirect_uris'))).toBeVisible();
		await fireEvent.click(enable);
		expect(view.clients.setEnabled).not.toHaveBeenCalled();
	});

	it(
		'uses the saved version when disabling a newly enabled client',
		{ timeout: 15_000 },
		async () => {
			const view = liveStory();
			await fireEvent.click(await view.findByRole('button', { name: t('sf.live.enable') }));
			const disable = await view.findByRole('button', { name: t('sf.live.disable') });
			expect(disable).toBeEnabled();
			await fireEvent.click(disable);
			await view.findByRole('button', { name: t('sf.live.enable') });
			expect(view.clients.setEnabled).toHaveBeenNthCalledWith(1, 'portal', true, 1000);
			expect(view.clients.setEnabled).toHaveBeenNthCalledWith(2, 'portal', false, 1001);
		}
	);

	it('shows a settings-save error for refused callbacks and keeps the activation state', async () => {
		const view = liveStory({ enabled: true, refuseMissingCallbacks: true });
		await view.findByRole('textbox', { name: t('sf.row.name') });
		await fireEvent.click(
			view.getByRole('button', {
				name: t('list.remove', { name: 'https://portal.example.test/callback' })
			})
		);
		await fireEvent.click(view.getByRole('button', { name: t('common.save') }));
		await view.findByText(t('common.saveFailed'));
		expect(view.clients.updateBasics).toHaveBeenCalledWith('portal', {
			redirect_uris: [],
			expected_updated_at: 1000
		});
		expect(view.queryByText(t('sf.live.activationFailed'))).toBeNull();
		expect(view.getByRole('button', { name: t('sf.live.disable') })).toBeEnabled();
		expect(view.queryByText(t('sf.live.saved'))).toBeNull();
	});
});
