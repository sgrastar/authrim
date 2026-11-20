<script module lang="ts">
	import { defineMeta } from '@storybook/addon-svelte-csf';
	import { expect, fn, userEvent, waitFor, within } from 'storybook/test';
	import {
		createFakeFederationSources,
		MOCK_FEDERATION_CERTIFICATE,
		MOCK_FEDERATION_FINGERPRINT,
		MOCK_FEDERATION_SOURCES
	} from '#lib/api/fake/federation-sources-fake.js';
	import { AggregateMetadataError } from '#lib/api/saml-providers.js';
	import { t } from '#lib/i18n/i18n.svelte.js';
	import LiveAddConnection from './LiveAddConnection.svelte';
	import type { ConnectionCreationResources } from './connection-creation';
	import { fingerprintDisplay } from './federation-model';

	const { Story } = defineMeta({
		title: 'Pages/Service flows/Federation wizard',
		component: LiveAddConnection,
		tags: ['draft'],
		parameters: {
			layout: 'fullscreen',
			docs: {
				description: {
					component:
						'Adding a SAML federation (an aggregate metadata document trusted as a whole): its address and signing certificate, then who takes part. Everyone in the federation takes part unless set aside, so there is no per-entity tick box.'
				}
			}
		}
	});

	type Canvas = ReturnType<typeof within>;
	const URL_OF_FEDERATION = 'https://metadata.example/aggregate.xml';
	const SETS = [
		{ value: 'set-sp', label: 'Tenant default (SP)' },
		{ value: 'set-idp', label: 'Tenant default (IdP)' }
	];

	function resources(
		options: { canCreate?: ConnectionCreationResources['canCreate']; aggregate?: boolean } = {}
	) {
		const fake = createFakeFederationSources({ sources: [] });
		const navigate = fn(async (_path: string) => {});
		const value: ConnectionCreationResources = {
			clients: { create: fn() },
			samlProviders: { createServiceProvider: fn() },
			federationSources: fake,
			federationMappingSets: async () => SETS,
			canCreate: options.canCreate ?? (() => true),
			...(options.aggregate
				? {
						previewMetadata: async () => {
							throw new AggregateMetadataError(URL_OF_FEDERATION);
						}
					}
				: {})
		};
		return { fake, navigate, value };
	}

	const next = (canvas: Canvas) => canvas.getByRole('button', { name: t('wizard.next') });
	/** Picks the way (out: services sign in through Authrim; in: people sign in elsewhere) and the federation kind. */
	async function toFederation(canvas: Canvas, direction: 'out' | 'in') {
		await userEvent.click(
			canvas.getByRole('radio', {
				name: new RegExp(
					`^${t(direction === 'out' ? 'sf.wizard.out.label' : 'sf.wizard.in.label')}`
				)
			})
		);
		await userEvent.click(next(canvas));
		await userEvent.click(canvas.getByRole('radio', { name: /^A SAML federation/ }));
		await userEvent.click(next(canvas));
	}
	async function addCertificate(canvas: Canvas, pem = MOCK_FEDERATION_CERTIFICATE) {
		await userEvent.click(canvas.getByRole('textbox', { name: t('sf.fed.cert.paste') }));
		await userEvent.paste(pem);
		await userEvent.click(canvas.getByRole('button', { name: t('sf.fed.cert.add') }));
	}
	async function fillSource(canvas: Canvas) {
		await userEvent.type(
			canvas.getByRole('textbox', { name: t('sf.fed.name') }),
			'Test federation'
		);
		await userEvent.type(
			canvas.getByRole('textbox', { name: t('sf.fed.metadataUrl') }),
			URL_OF_FEDERATION
		);
		await addCertificate(canvas);
		await canvas.findByText(fingerprintDisplay(MOCK_FEDERATION_FINGERPRINT));
	}

	const out = resources();
	const inbound = resources();
	const happy = resources();
	const invalid = resources();
	const viewer = resources({ canCreate: (kind) => kind !== 'federation' });
	const aggregate = resources({ aggregate: true });
</script>

<Story
	name="From the way out, the SP role starts on"
	args={{ resources: out.value, onnavigate: out.navigate }}
	play={async ({ canvasElement }) => {
		const canvas = within(canvasElement);
		await toFederation(canvas, 'out');
		await fillSource(canvas);
		await userEvent.click(next(canvas));
		await expect(canvas.getByRole('switch', { name: t('sf.fed.role.sp') })).toBeChecked();
		await expect(canvas.getByRole('switch', { name: t('sf.fed.role.idp') })).not.toBeChecked();
	}}
/>

<Story
	name="From the way in, the IdP role starts on"
	args={{ resources: inbound.value, onnavigate: inbound.navigate }}
	play={async ({ canvasElement }) => {
		const canvas = within(canvasElement);
		await toFederation(canvas, 'in');
		await fillSource(canvas);
		await userEvent.click(next(canvas));
		await expect(canvas.getByRole('switch', { name: t('sf.fed.role.idp') })).toBeChecked();
		await expect(canvas.getByRole('switch', { name: t('sf.fed.role.sp') })).not.toBeChecked();
		// An IdP role chooses how people pick their institution; Authrim's own search is the default.
		await expect(
			canvas.getByRole('combobox', { name: t('sf.fed.idpSelection.label') })
		).toHaveValue('authrim_search');
	}}
/>

<Story
	name="SP role: fingerprint, mapping set, saved, first fetch, open"
	args={{ resources: happy.value, onnavigate: happy.navigate }}
	play={async ({ canvasElement }) => {
		const canvas = within(canvasElement);
		await toFederation(canvas, 'out');
		await expect(next(canvas)).toBeDisabled();
		await fillSource(canvas);
		await expect(next(canvas)).toBeEnabled();
		await userEvent.click(next(canvas));

		const save = canvas.getByRole('button', { name: t('sf.create.save') });
		await expect(save).toBeDisabled();
		const set = canvas.getByRole('combobox', { name: t('sf.fed.mappingSet.sp') });
		await waitFor(() => expect(set).toBeEnabled());
		await userEvent.selectOptions(set, 'set-sp');
		await expect(save).toBeEnabled();
		await userEvent.click(save);

		// What it made fetches once and says what came in.
		await canvas.findByText(t('sf.fed.created.ok'));
		await expect(canvas.getByText('1200')).toBeVisible();
		await expect(happy.fake.calls.created).toHaveLength(1);
		await expect(happy.fake.calls.created[0]).toMatchObject({
			sourceKey: URL_OF_FEDERATION,
			name: 'Test federation',
			lifecycleState: 'active',
			payload: {
				metadataUrl: URL_OF_FEDERATION,
				runtimeResolution: { mode: 'automatic', roles: ['saml_sp'], spFieldMappingSetId: 'set-sp' },
				exceptions: { excludedEntityIds: [] },
				idpSelection: { mode: 'authrim_search' }
			}
		});
		await expect(happy.fake.calls.refreshed).toEqual(['federation-1']);
		await userEvent.click(canvas.getByRole('button', { name: t('sf.fed.created.open') }));
		await waitFor(() =>
			expect(happy.navigate).toHaveBeenCalledWith('/admin/applications/all/federation/federation-1')
		);
	}}
/>

<Story
	name="Each step goes on only when it is complete"
	args={{ resources: invalid.value, onnavigate: invalid.navigate }}
	play={async ({ canvasElement }) => {
		const canvas = within(canvasElement);
		await toFederation(canvas, 'out');
		await userEvent.type(canvas.getByRole('textbox', { name: t('sf.fed.name') }), 'Federation');
		await userEvent.type(
			canvas.getByRole('textbox', { name: t('sf.fed.metadataUrl') }),
			'http://plain.example/a.xml'
		);
		await canvas.findByText(t('sf.fed.error.metadataUrl'));
		await addCertificate(canvas, 'not a certificate');
		await canvas.findByText(t('sf.fed.cert.invalid'));
		await expect(next(canvas)).toBeDisabled();
		const url = canvas.getByRole('textbox', { name: t('sf.fed.metadataUrl') });
		await userEvent.clear(url);
		await userEvent.type(url, URL_OF_FEDERATION);
		await userEvent.clear(canvas.getByRole('textbox', { name: t('sf.fed.cert.paste') }));
		await addCertificate(canvas);
		await canvas.findByText(fingerprintDisplay(MOCK_FEDERATION_FINGERPRINT));
		await userEvent.click(next(canvas));

		// A role with no mapping set, and no role at all, each say what is missing.
		const save = canvas.getByRole('button', { name: t('sf.create.save') });
		await canvas.findByText(t('sf.fed.error.spMapping'));
		await userEvent.click(canvas.getByRole('switch', { name: t('sf.fed.role.sp') }));
		await canvas.findByText(t('sf.fed.error.roles'));
		await expect(save).toBeDisabled();
		// An external discovery service needs an https address.
		await userEvent.click(canvas.getByRole('switch', { name: t('sf.fed.role.idp') }));
		const set = canvas.getByRole('combobox', { name: t('sf.fed.mappingSet.idp') });
		await waitFor(() => expect(set).toBeEnabled());
		await userEvent.selectOptions(set, 'set-idp');
		await userEvent.selectOptions(
			canvas.getByRole('combobox', { name: t('sf.fed.idpSelection.label') }),
			'external_ds'
		);
		await expect(save).toBeDisabled();
		await userEvent.type(
			canvas.getByRole('textbox', { name: t('sf.fed.idpSelection.dsUrl') }),
			'http://ds.example'
		);
		await canvas.findAllByText(t('sf.fed.error.dsUrl'));
		await expect(save).toBeDisabled();
		const ds = canvas.getByRole('textbox', { name: t('sf.fed.idpSelection.dsUrl') });
		await userEvent.clear(ds);
		await userEvent.type(ds, 'https://ds.example/discovery');
		await expect(save).toBeEnabled();
		await expect(invalid.fake.calls.created).toHaveLength(0);
	}}
/>

<Story
	name="Without permission the federation card is not offered"
	args={{ resources: viewer.value, onnavigate: viewer.navigate }}
	play={async ({ canvasElement }) => {
		const canvas = within(canvasElement);
		await userEvent.click(
			canvas.getByRole('radio', { name: new RegExp(`^${t('sf.wizard.out.label')}`) })
		);
		await userEvent.click(next(canvas));
		await expect(canvas.getByRole('radio', { name: /^A service that uses SAML/ })).toBeVisible();
		await expect(canvas.queryByRole('radio', { name: /^A SAML federation/ })).toBeNull();
		await expect(canvas.getAllByRole('radio')).toHaveLength(2);
	}}
/>

<Story
	name="Aggregate metadata offers to add it as a federation"
	args={{ resources: aggregate.value, onnavigate: aggregate.navigate }}
	play={async ({ canvasElement }) => {
		const canvas = within(canvasElement);
		await userEvent.click(
			canvas.getByRole('radio', { name: new RegExp(`^${t('sf.wizard.out.label')}`) })
		);
		await userEvent.click(next(canvas));
		await userEvent.click(canvas.getByRole('radio', { name: /^A service that uses SAML/ }));
		await userEvent.click(next(canvas));
		await userEvent.type(
			canvas.getByRole('textbox', { name: t('sf.ours.metadataUrl') }),
			URL_OF_FEDERATION
		);
		await userEvent.click(canvas.getByRole('button', { name: t('sf.import.read') }));
		await canvas.findByText(t('sf.metadata.aggregate'));
		await userEvent.click(canvas.getByRole('button', { name: t('sf.metadata.addAsFederation') }));

		// The wizard is now the federation's, with the address in it and the way chosen kept.
		await expect(canvas.getByRole('textbox', { name: t('sf.fed.metadataUrl') })).toHaveValue(
			URL_OF_FEDERATION
		);
		await userEvent.type(canvas.getByRole('textbox', { name: t('sf.fed.name') }), 'Imported');
		await addCertificate(canvas);
		await canvas.findByText(fingerprintDisplay(MOCK_FEDERATION_FINGERPRINT));
		await userEvent.click(next(canvas));
		await expect(canvas.getByRole('switch', { name: t('sf.fed.role.sp') })).toBeChecked();
		await expect(MOCK_FEDERATION_SOURCES.length).toBeGreaterThan(0);
	}}
/>
