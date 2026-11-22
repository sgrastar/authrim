<script module lang="ts">
	import { defineMeta } from '@storybook/addon-svelte-csf';
	import { expect, fn, userEvent, waitFor, within } from 'storybook/test';
	import {
		createFakeFederationSources,
		MOCK_FEDERATION_CERTIFICATE,
		MOCK_FEDERATION_FINGERPRINT,
		MOCK_FEDERATION_FINGERPRINT_SHA1,
		MOCK_FEDERATION_SOURCES
	} from '#lib/api/fake/federation-sources-fake.js';
	import { AggregateMetadataError } from '#lib/api/saml-providers.js';
	import { t } from '#lib/i18n/i18n.svelte.js';
	import LiveAddConnection from './LiveAddConnection.svelte';
	import type { ConnectionCreationResources } from './connection-creation';
	import { fingerprintDisplay } from './federation-model';
	import { fingerprintText } from './federation-fingerprint.fixture';

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
		// One way of adding at a time: the address is the first, pasting is picked.
		await userEvent.click(canvas.getByRole('radio', { name: t('sf.fed.cert.mode.paste') }));
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
		await canvas.findByText(fingerprintText(fingerprintDisplay(MOCK_FEDERATION_FINGERPRINT)));
	}

	const out = resources();
	const inbound = resources();
	const happy = resources();
	const invalid = resources();
	const viewer = resources({ canCreate: (kind) => kind !== 'federation' });
	const aggregate = resources({ aggregate: true });
</script>

<Story
	name="From the way out, the SP role is made and the wizard ends at the source"
	args={{ resources: out.value, onnavigate: out.navigate }}
	play={async ({ canvasElement }) => {
		const canvas = within(canvasElement);
		await toFederation(canvas, 'out');
		const save = canvas.getByRole('button', { name: t('sf.create.save') });
		await expect(save).toBeDisabled();
		await fillSource(canvas);
		// No step asks for a mapping set: it is chosen on the federation's own page.
		await expect(canvas.queryByRole('combobox', { name: t('sf.fed.mappingSet.sp') })).toBeNull();
		await expect(canvas.queryByRole('switch')).toBeNull();
		await userEvent.click(save);
		await canvas.findByText(t('sf.fed.created.ok'));
		await expect(canvas.getByText(t('sf.fed.created.mappingNeeded'))).toBeVisible();
		await expect(out.fake.calls.created[0]).toMatchObject({
			lifecycleState: 'active',
			payload: { runtimeResolution: { mode: 'inventory_only', roles: ['saml_sp'] } }
		});
		// A role with no set has no id at all: the server refuses an empty one.
		await expect(JSON.stringify(out.fake.calls.created[0])).not.toContain('FieldMappingSetId');
	}}
/>

<Story
	name="From the way in, the IdP role is made"
	args={{ resources: inbound.value, onnavigate: inbound.navigate }}
	play={async ({ canvasElement }) => {
		const canvas = within(canvasElement);
		await toFederation(canvas, 'in');
		await fillSource(canvas);
		await userEvent.click(canvas.getByRole('button', { name: t('sf.create.save') }));
		await canvas.findByText(t('sf.fed.created.ok'));
		await expect(inbound.fake.calls.created[0]).toMatchObject({
			payload: {
				runtimeResolution: { mode: 'inventory_only', roles: ['saml_idp'] },
				idpSelection: { mode: 'authrim_search' }
			}
		});
	}}
/>

<Story
	name="Saved, first fetch, open the federation"
	args={{ resources: happy.value, onnavigate: happy.navigate }}
	play={async ({ canvasElement }) => {
		const canvas = within(canvasElement);
		await toFederation(canvas, 'out');
		await fillSource(canvas);
		await userEvent.click(canvas.getByRole('button', { name: t('sf.create.save') }));

		// What it made fetches once and says what came in.
		await canvas.findByText(t('sf.fed.created.ok'));
		await expect(canvas.getByText('1200')).toBeVisible();
		await expect(happy.fake.calls.created).toHaveLength(1);
		await expect(happy.fake.calls.created[0]).toMatchObject({
			sourceKey: URL_OF_FEDERATION,
			name: 'Test federation',
			payload: {
				metadataUrl: URL_OF_FEDERATION,
				exceptions: { excludedEntityIds: [] }
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
	name="A certificate is added one way at a time: its address, pasting, or a file"
	args={{ resources: invalid.value, onnavigate: invalid.navigate }}
	play={async ({ canvasElement }) => {
		const canvas = within(canvasElement);
		await toFederation(canvas, 'out');
		const field = (name: string) => canvas.queryByText(name, { selector: 'label' });
		// The address is the first way; the other two are not shown yet.
		await canvas.findByRole('textbox', { name: t('sf.fed.cert.url') });
		await expect(canvas.queryByRole('textbox', { name: t('sf.fed.cert.paste') })).toBeNull();
		await expect(canvas.queryByText(t('sf.fed.cert.file'))).toBeNull();
		await userEvent.click(canvas.getByRole('radio', { name: t('sf.fed.cert.mode.paste') }));
		await canvas.findByRole('textbox', { name: t('sf.fed.cert.paste') });
		await expect(canvas.queryByRole('textbox', { name: t('sf.fed.cert.url') })).toBeNull();
		await userEvent.click(canvas.getByRole('radio', { name: t('sf.fed.cert.mode.file') }));
		await canvas.findByText(t('sf.fed.cert.fileHint'));
		await expect(canvas.queryByRole('textbox', { name: t('sf.fed.cert.paste') })).toBeNull();
		await expect(field(t('sf.fed.cert.url'))).toBeNull();
	}}
/>

<Story
	name="A certificate read from its address shows both fingerprints"
	args={{ resources: invalid.value, onnavigate: invalid.navigate }}
	play={async ({ canvasElement }) => {
		const canvas = within(canvasElement);
		await toFederation(canvas, 'out');
		const address = canvas.getByRole('textbox', { name: t('sf.fed.cert.url') });
		const read = () => canvas.getByRole('button', { name: t('sf.fed.cert.urlRead') });
		// An address that does not serve a certificate says so, and adds nothing.
		await userEvent.type(address, 'https://federation.example/unreachable.cer');
		await userEvent.click(read());
		await canvas.findByText(t('sf.fed.cert.urlFailed'));
		await expect(canvas.queryByText(t('sf.fed.cert.fingerprint'))).toBeNull();
		// One that does: the certificate is kept, with SHA-256 and SHA-1 worked out from it.
		await userEvent.clear(address);
		await userEvent.type(address, 'https://federation.example/signer.cer');
		await userEvent.click(read());
		await canvas.findByText(fingerprintText(fingerprintDisplay(MOCK_FEDERATION_FINGERPRINT)));
		await canvas.findByText(fingerprintText(fingerprintDisplay(MOCK_FEDERATION_FINGERPRINT_SHA1)));
		await canvas.findByText(t('sf.fed.cert.fingerprintSha1'));
		// The delete button says what it deletes.
		await expect(
			canvas.getByRole('button', { name: new RegExp(`^${t('sf.fed.cert.remove')} \\(AA:7B`) })
		).toBeVisible();
	}}
/>

<Story
	name="A link copied from a page is not the metadata's address"
	args={{ resources: invalid.value, onnavigate: invalid.navigate }}
	play={async ({ canvasElement }) => {
		const canvas = within(canvasElement);
		await toFederation(canvas, 'out');
		await userEvent.type(
			canvas.getByRole('textbox', { name: t('sf.fed.metadataUrl') }),
			'https://www.example.org/join/rule#:~:text=https%3A//metadata.example.org/a.xml'
		);
		await canvas.findByText(t('sf.fed.error.metadataUrlFragment'));
	}}
/>

<Story
	name="The federation is saved only when its address and certificate are right"
	args={{ resources: invalid.value, onnavigate: invalid.navigate }}
	play={async ({ canvasElement }) => {
		const canvas = within(canvasElement);
		await toFederation(canvas, 'in');
		await userEvent.type(canvas.getByRole('textbox', { name: t('sf.fed.name') }), 'Federation');
		await userEvent.type(
			canvas.getByRole('textbox', { name: t('sf.fed.metadataUrl') }),
			'http://plain.example/a.xml'
		);
		await canvas.findByText(t('sf.fed.error.metadataUrl'));
		await addCertificate(canvas, 'not a certificate');
		await canvas.findByText(t('sf.fed.cert.invalid'));
		await expect(canvas.getByRole('button', { name: t('sf.create.save') })).toBeDisabled();
		const url = canvas.getByRole('textbox', { name: t('sf.fed.metadataUrl') });
		await userEvent.clear(url);
		await userEvent.type(url, URL_OF_FEDERATION);
		await userEvent.clear(canvas.getByRole('textbox', { name: t('sf.fed.cert.paste') }));
		await addCertificate(canvas);
		await canvas.findByText(fingerprintText(fingerprintDisplay(MOCK_FEDERATION_FINGERPRINT)));
		await expect(canvas.getByRole('button', { name: t('sf.create.save') })).toBeEnabled();
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
		await canvas.findByText(fingerprintText(fingerprintDisplay(MOCK_FEDERATION_FINGERPRINT)));
		await expect(canvas.getByRole('button', { name: t('sf.create.save') })).toBeEnabled();
		await expect(MOCK_FEDERATION_SOURCES.length).toBeGreaterThan(0);
	}}
/>
