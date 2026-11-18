<script module lang="ts">
	import { tick } from 'svelte';
	import { defineMeta } from '@storybook/addon-svelte-csf';
	import { expect, fn, userEvent, waitFor, within } from 'storybook/test';
	import { t } from '#lib/i18n/i18n.svelte.js';
	import MetadataConnectionHarness from './MetadataConnectionHarness.svelte';
	import { metadataHttpFixture, metadataXml } from './metadata-http.fixture';

	let http = metadataHttpFixture();
	const { Story } = defineMeta({
		title: 'Pages/Service flows/Live SAML metadata',
		component: MetadataConnectionHarness,
		parameters: { layout: 'fullscreen' },
		beforeEach: ({ args }) => {
			http = metadataHttpFixture(args.kind === 'idp' ? 'saml_idp' : 'saml_sp');
			const previous = globalThis.fetch;
			globalThis.fetch = http.fetcher;
			return () => {
				globalThis.fetch = previous;
			};
		}
	});
	function providerReadCount() {
		return http.fetcher.mock.calls.filter(
			([url, init]) =>
				String(url).endsWith('/saml-providers/portal') && (!init?.method || init.method === 'GET')
		).length;
	}
	type Canvas = ReturnType<typeof within>;
	async function choose(canvas: Canvas, kind: 'sp' | 'idp') {
		await userEvent.click(
			canvas.getByRole('radio', {
				name: new RegExp(`^${t(kind === 'sp' ? 'sf.wizard.out.label' : 'sf.wizard.in.label')}`)
			})
		);
		await userEvent.click(canvas.getByRole('button', { name: t('wizard.next') }));
		await userEvent.click(
			canvas.getByRole('radio', { name: new RegExp(`^${t(`sf.wizard.kind.${kind}.label`)}`) })
		);
		await userEvent.click(canvas.getByRole('button', { name: t('wizard.next') }));
		await userEvent.type(
			canvas.getByRole('textbox', { name: t('sf.row.name') }),
			'Metadata connection'
		);
	}
	async function url(canvas: Canvas, source = 'https://metadata.example.test/sp.xml') {
		await userEvent.click(canvas.getByRole('radio', { name: t('sf.ours.metadataUrl') }));
		const field = canvas.getByRole('textbox', { name: t('sf.ours.metadataUrl') });
		await userEvent.clear(field);
		await userEvent.type(field, source);
		await userEvent.click(canvas.getByRole('button', { name: t('sf.import.read') }));
	}
	async function openImport(canvas: Canvas) {
		const heading = await canvas.findByText(t('sf.metadata.title'), { selector: 'summary *' });
		const details = heading.closest('details');
		if (!details) throw new Error('Expected metadata import disclosure');
		await userEvent.click(heading);
		await tick();
		await waitFor(() => expect(details).toHaveAttribute('open'));
		await Promise.all(
			details.getAnimations({ subtree: true }).map((animation: Animation) => animation.finished)
		);
	}
	async function change(canvas: Canvas, label: string, value: string) {
		const input = await canvas.findByRole('textbox', { name: label });
		await userEvent.clear(input);
		await userEvent.type(input, value);
	}
	async function confirmImport(canvas: Canvas) {
		await userEvent.click(canvas.getByRole('button', { name: t('sf.metadata.confirm') }));
		const dialog = within(await within(document.body).findByRole('dialog'));
		const confirm = dialog.getByRole('button', { name: t('sf.metadata.confirm') });
		await waitFor(() => expect(confirm).toBeVisible());
		await userEvent.click(confirm);
	}
</script>

<Story
	name="URL SP preview then explicit create, reopen and manual edit over HTTP"
	play={async ({ canvasElement }) => {
		const canvas = within(canvasElement);
		await choose(canvas, 'sp');
		await url(canvas);
		await canvas.findByText('urn:synthetic:saml_sp');
		await expect(http.writes).toHaveLength(0);
		await expect(canvas.getByText(t('sf.metadata.previewOnly'))).toBeVisible();
		await userEvent.click(canvas.getByRole('button', { name: t('sf.create.save') }));
		await canvas.findByRole('heading', { name: t('af.general') });
		await expect(http.writes[0]).toEqual({
			name: 'Metadata connection',
			providerType: 'saml_sp',
			enabled: false,
			metadataXml: metadataXml('saml_sp'),
			metadataUrl: 'https://metadata.example.test/sp.xml'
		});
		await expect(canvas.getByRole('textbox', { name: t('sf.row.entityId') })).toHaveValue(
			'urn:synthetic:saml_sp'
		);
		await change(canvas, t('sf.ours.acsUrl'), 'https://synthetic.example.test/new-acs');
		await userEvent.click(canvas.getByRole('button', { name: t('common.save') }));
		await canvas.findByText(t('sf.live.saved'));
		await expect(http.current().config).toMatchObject(http.protectedConfig);
		await expect(http.current().config).toMatchObject({
			metadataXml: metadataXml('saml_sp'),
			metadataUrl: 'https://metadata.example.test/sp.xml',
			acsUrl: 'https://synthetic.example.test/new-acs'
		});
		await userEvent.click(canvas.getByRole('button', { name: t('sf.live.reload') }));
		await expect(canvas.getByRole('textbox', { name: t('sf.ours.acsUrl') })).toHaveValue(
			'https://synthetic.example.test/new-acs'
		);
	}}
/>

<Story
	name="File IdP preview then create and reopen actual stored values"
	args={{ kind: 'idp' }}
	play={async ({ canvasElement }) => {
		const canvas = within(canvasElement);
		await choose(canvas, 'idp');
		await userEvent.click(canvas.getByRole('radio', { name: t('sf.import.mode.file') }));
		await userEvent.upload(
			canvas.getByLabelText(t('file.chooseOne')),
			new File([metadataXml('saml_idp')], 'idp.xml', { type: 'application/xml' })
		);
		await canvas.findByText('urn:synthetic:saml_idp');
		await expect(canvas.getByText(t('sf.metadata.certificates', { count: 1 }))).toBeVisible();
		await expect(http.writes).toHaveLength(0);
		await userEvent.click(canvas.getByRole('button', { name: t('sf.create.save') }));
		await canvas.findByRole('heading', { name: 'Metadata connection' });
		await expect(providerReadCount()).toBe(1);
		await expect(http.writes[0]).toEqual({
			name: 'Metadata connection',
			providerType: 'saml_idp',
			enabled: false,
			metadataXml: metadataXml('saml_idp'),
			config: { jitEmailLinkingPolicy: 'disabled', allowSyntheticEmailFallback: false }
		});
		await expect(canvas.getByRole('textbox', { name: t('sf.row.entityId') })).toHaveValue(
			'urn:synthetic:saml_idp'
		);
		await change(canvas, t('sf.ours.ssoUrl'), 'https://synthetic.example.test/new-sso');
		await userEvent.click(canvas.getByRole('button', { name: t('common.save') }));
		await canvas.findByText(t('sf.live.saved'));
		await expect(http.current().config).toMatchObject({
			...http.protectedConfig,
			metadataXml: metadataXml('saml_idp'),
			ssoUrl: 'https://synthetic.example.test/new-sso'
		});
		await expect(providerReadCount()).toBe(1);
		for (const expectedReads of [2, 3]) {
			await userEvent.click(canvas.getByRole('button', { name: t('sf.detail.back') }));
			await userEvent.click(canvas.getByRole('button', { name: 'Reopen connection' }));
			await canvas.findByRole('heading', { name: 'Metadata connection' });
			await expect(canvas.getByRole('textbox', { name: t('sf.ours.ssoUrl') })).toHaveValue(
				'https://synthetic.example.test/new-sso'
			);
			await expect(providerReadCount()).toBe(expectedReads);
		}
	}}
/>

<Story
	name="Manual SP creation remains available without any metadata preview"
	play={async ({ canvasElement }) => {
		const canvas = within(canvasElement);
		await choose(canvas, 'sp');
		await userEvent.click(canvas.getByRole('radio', { name: t('sf.import.mode.manual') }));
		await change(canvas, t('sf.row.entityId'), 'urn:manual:service');
		await change(canvas, t('sf.ours.acsUrl'), 'https://manual.example.test/acs');
		await userEvent.click(canvas.getByRole('button', { name: t('sf.create.save') }));
		await canvas.findByRole('heading', { name: t('af.general') });
		await expect(http.preview).not.toHaveBeenCalled();
		await expect(http.writes[0]).toMatchObject({
			enabled: false,
			config: { entityId: 'urn:manual:service', acsUrl: 'https://manual.example.test/acs' }
		});
	}}
/>

<Story
	name="Stale URL response, error retry and manual draft preservation"
	play={async ({ canvasElement }) => {
		const canvas = within(canvasElement);
		await choose(canvas, 'sp');
		await userEvent.click(canvas.getByRole('radio', { name: t('sf.import.mode.manual') }));
		await change(canvas, t('sf.row.entityId'), 'urn:manual:draft');
		await change(canvas, t('sf.ours.acsUrl'), 'https://manual.example.test/acs');
		let release: ((response: Response) => void) | undefined;
		http.preview.mockImplementationOnce(
			async () =>
				new Promise<Response>((resolve) => {
					release = resolve;
				})
		);
		await url(canvas);
		await waitFor(() => expect(http.preview).toHaveBeenCalledTimes(1));
		await expect(canvas.getByRole('button', { name: t('sf.create.save') })).toBeDisabled();
		await change(canvas, t('sf.ours.metadataUrl'), 'https://metadata.example.test/new-sp.xml');
		release?.(
			Response.json({
				kind: 'single',
				providerType: 'saml_sp',
				config: {
					entityId: 'urn:stale',
					acsUrl: 'https://stale.example.test/acs',
					metadataXml: metadataXml('saml_sp')
				}
			})
		);
		await expect(canvas.queryByText('urn:stale')).toBeNull();
		http.preview.mockResolvedValueOnce(
			Response.json(
				{ error: 'invalid_request', error_description: 'Retry this preview' },
				{ status: 400 }
			)
		);
		await userEvent.click(canvas.getByRole('button', { name: t('sf.import.read') }));
		await canvas.findByText('Retry this preview');
		await expect(http.writes).toHaveLength(0);
		await userEvent.click(canvas.getByRole('button', { name: t('sf.import.read') }));
		await canvas.findByText('urn:synthetic:saml_sp');
		await expect(canvas.queryByText('urn:stale')).toBeNull();
		await userEvent.click(canvas.getByRole('radio', { name: t('sf.import.mode.manual') }));
		await expect(canvas.getByRole('textbox', { name: t('sf.row.entityId') })).toHaveValue(
			'urn:manual:draft'
		);
		await expect(canvas.getByRole('textbox', { name: t('sf.ours.acsUrl') })).toHaveValue(
			'https://manual.example.test/acs'
		);
	}}
/>

<Story
	name="Wrong role, malformed XML and oversize files never enable create"
	play={async ({ canvasElement }) => {
		const canvas = within(canvasElement);
		await choose(canvas, 'sp');
		await url(canvas, 'https://metadata.example.test/idp.xml');
		await canvas.findByText(t('sf.metadata.wrongRoleSp'));
		await expect(canvas.getByRole('button', { name: t('sf.create.save') })).toBeDisabled();
		await userEvent.click(canvas.getByRole('radio', { name: t('sf.import.mode.file') }));
		const picker = canvas.getByLabelText(t('file.chooseOne'));
		await userEvent.upload(
			picker,
			new File(['<broken'], 'broken.xml', { type: 'application/xml' })
		);
		await canvas.findByText(t('sf.metadata.invalidXml'));
		const readText = fn(async () => 'must not read');
		const oversized = new File(['x'.repeat(1024 * 1024 + 1)], 'oversized.xml', {
			type: 'application/xml'
		});
		Object.defineProperty(oversized, 'text', { value: readText });
		await userEvent.upload(picker, oversized);
		await canvas.findByRole('alert');
		await expect(readText).not.toHaveBeenCalled();
		await expect(http.preview).toHaveBeenCalledTimes(2);
		await expect(http.writes).toHaveLength(0);
		await expect(canvas.getByRole('button', { name: t('sf.create.save') })).toBeDisabled();
	}}
/>

<Story
	name="Dirty SP import confirmation and pending preview survive Mapping node switches"
	args={{ existing: true }}
	play={async ({ canvasElement }) => {
		const canvas = within(canvasElement);
		await change(canvas, t('sf.row.name'), 'Unsaved name');
		await openImport(canvas);
		let release: ((response: Response) => void) | undefined;
		const normalPreview = http.preview.getMockImplementation();
		http.preview.mockImplementationOnce(
			async () =>
				new Promise<Response>((resolve) => {
					release = resolve;
				})
		);
		await url(canvas);
		await waitFor(() => expect(http.preview).toHaveBeenCalledTimes(1));
		await userEvent.click(
			canvas.getByRole('button', { name: new RegExp(`^${t('sf.part.mapping-sets')}`) })
		);
		await userEvent.click(canvas.getAllByRole('button', { name: t('af.general') })[0]);
		await expect(canvas.getByRole('textbox', { name: t('sf.row.name') })).toHaveValue(
			'Unsaved name'
		);
		await expect(canvas.getByRole('button', { name: t('sf.metadata.confirm') })).toBeDisabled();
		if (!normalPreview || !release) throw new Error('Preview did not start');
		release(
			await normalPreview({
				providerType: 'saml_sp',
				metadataUrl: 'https://metadata.example.test/sp.xml'
			})
		);
		await canvas.findByText('urn:synthetic:saml_sp');
		await userEvent.click(canvas.getByRole('button', { name: t('sf.metadata.confirm') }));
		let dialog = within(await within(document.body).findByRole('dialog'));
		await waitFor(() => expect(dialog.getByText(t('sf.metadata.dirtyConfirm'))).toBeVisible());
		await userEvent.click(dialog.getByRole('button', { name: t('common.cancel') }));
		await expect(http.writes).toHaveLength(0);
		await expect(canvas.getByRole('textbox', { name: t('sf.row.name') })).toHaveValue(
			'Unsaved name'
		);
		await confirmImport(canvas);
		await waitFor(() => expect(http.writes).toHaveLength(1));
		await expect(http.writes[0]).toMatchObject({
			expectedUpdatedAt: '2026-11-16T00:00:00.000Z',
			metadataXml: metadataXml('saml_sp')
		});
		await expect(http.current().config).toMatchObject(http.protectedConfig);
		await expect(canvas.getByRole('textbox', { name: t('sf.row.name') })).toHaveValue(
			'Stored connection'
		);
	}}
/>

<Story
	name="Existing IdP import retains saved mapping and advances the loaded version"
	args={{ existing: true, kind: 'idp' }}
	play={async ({ canvasElement }) => {
		const canvas = within(canvasElement);
		await canvas.findByRole('textbox', { name: t('sf.row.name') });
		await expect(providerReadCount()).toBe(1);
		await openImport(canvas);
		await url(canvas, 'https://metadata.example.test/idp.xml');
		await canvas.findByText('urn:synthetic:saml_idp');
		await confirmImport(canvas);
		await waitFor(() => expect(http.writes).toHaveLength(1));
		await expect(http.current().config).toMatchObject(http.protectedConfig);
		await expect(canvas.getByRole('textbox', { name: t('sf.ours.ssoUrl') })).toHaveValue(
			'https://synthetic.example.test/sso'
		);
		await expect(providerReadCount()).toBe(1);
		await change(canvas, t('sf.row.name'), 'After import');
		await userEvent.click(canvas.getByRole('button', { name: t('common.save') }));
		await waitFor(() => expect(http.writes).toHaveLength(2));
		await expect(http.writes[1].expectedUpdatedAt).toBe('2026-11-17T00:00:01.000Z');
		await expect(providerReadCount()).toBe(1);
	}}
/>

<Story
	name="Read only metadata controls respect separate preview and import permissions"
	args={{ existing: true, canEdit: false, canPreview: false, canImport: true }}
	play={async ({ canvasElement }) => {
		const canvas = within(canvasElement);
		await openImport(canvas);
		await canvas.findByText(t('sf.metadata.permissions'));
		await expect(canvas.queryByRole('button', { name: t('sf.import.read') })).toBeNull();
		await expect(canvas.queryByRole('button', { name: t('sf.metadata.confirm') })).toBeNull();
		await expect(http.preview).not.toHaveBeenCalled();
		await expect(http.writes).toHaveLength(0);
	}}
/>

<Story
	name="SP skips metadata and opens a disabled draft with activation blocked"
	play={async ({ canvasElement }) => {
		const canvas = within(canvasElement);
		await choose(canvas, 'sp');
		await expect(canvas.getByRole('radio', { name: t('sf.ours.metadataUrl') })).toBeChecked();
		await userEvent.click(canvas.getByRole('button', { name: t('sf.draft.skip') }));
		await waitFor(() => {
			const save = canvas.getByRole('button', { name: t('sf.create.save') });
			expect(save).toBeVisible();
			expect(save).toBeEnabled();
		});
		await userEvent.click(canvas.getByRole('button', { name: t('sf.create.save') }));
		await waitFor(() => expect(canvas.getByText(t('sf.draft.saved'))).toBeVisible());
		await expect(http.writes[0]).toEqual({
			name: 'Metadata connection',
			providerType: 'saml_sp',
			enabled: false
		});
		await userEvent.click(canvas.getByRole('button', { name: t('sf.draft.openDetails') }));
		await waitFor(() => {
			expect(canvas.getByText(t('sf.draft.noMetadata'))).toBeVisible();
			expect(canvas.getByRole('button', { name: t('sf.live.enable') })).toBeDisabled();
			expect(canvas.getByText(t('sf.draft.metadataRequired'))).toBeVisible();
		});
	}}
/>

<Story
	name="IdP skips metadata and opens a disabled draft"
	args={{ kind: 'idp' }}
	play={async ({ canvasElement }) => {
		const canvas = within(canvasElement);
		await choose(canvas, 'idp');
		await userEvent.click(canvas.getByRole('button', { name: t('sf.draft.skip') }));
		await userEvent.click(canvas.getByRole('button', { name: t('sf.create.save') }));
		await canvas.findByText(t('sf.draft.saved'));
		await expect(http.writes[0]).toEqual({
			name: 'Metadata connection',
			providerType: 'saml_idp',
			enabled: false,
			config: { jitEmailLinkingPolicy: 'disabled', allowSyntheticEmailFallback: false }
		});
		await userEvent.click(canvas.getByRole('button', { name: t('sf.draft.openDetails') }));
		await canvas.findByText(t('sf.draft.noMetadata'));
		await expect(canvas.getByRole('button', { name: t('sf.live.enable') })).toBeDisabled();
	}}
/>

<Story
	name="Paste XML previews automatically and creates from a single entity wrapper"
	play={async ({ canvasElement }) => {
		const canvas = within(canvasElement);
		await choose(canvas, 'sp');
		await userEvent.click(canvas.getByRole('radio', { name: t('sf.import.mode.xml') }));
		const input = canvas.getByRole('textbox', { name: t('sf.import.mode.xml') });
		await expect(input).toHaveValue('');
		await userEvent.click(input);
		await userEvent.paste(
			`<md:EntitiesDescriptor xmlns:md="urn:oasis:names:tc:SAML:2.0:metadata">${metadataXml('saml_sp')}</md:EntitiesDescriptor>`
		);
		await canvas.findByText('urn:synthetic:saml_sp');
		await expect(canvas.getByRole('button', { name: t('sf.create.save') })).toBeEnabled();
		await expect(http.writes).toHaveLength(0);
	}}
/>

<Story
	name="Existing connection switches to XML, previews a paste and resets after saving"
	args={{ existing: true }}
	play={async ({ canvasElement }) => {
		const canvas = within(canvasElement);
		await canvas.findByRole('textbox', { name: t('sf.row.name') });
		await openImport(canvas);
		await userEvent.click(canvas.getByRole('radio', { name: t('sf.import.mode.xml') }));
		let input = canvas.getByRole('textbox', { name: t('sf.import.mode.xml') });
		await expect(input).toHaveValue('');
		await userEvent.click(input);
		await userEvent.paste(metadataXml('saml_sp'));
		await canvas.findByText('urn:synthetic:saml_sp');
		await expect(canvas.getByRole('button', { name: t('sf.metadata.confirm') })).toBeEnabled();
		await confirmImport(canvas);
		await waitFor(() => expect(http.writes).toHaveLength(1));
		await expect(http.writes[0]).toMatchObject({ metadataXml: metadataXml('saml_sp') });
		await waitFor(() =>
			expect(canvas.getByRole('radio', { name: t('sf.ours.metadataUrl') })).toBeChecked()
		);
		await userEvent.click(canvas.getByRole('radio', { name: t('sf.import.mode.xml') }));
		input = canvas.getByRole('textbox', { name: t('sf.import.mode.xml') });
		await expect(input).toHaveValue('');
		await expect(canvas.getByRole('button', { name: t('sf.metadata.confirm') })).toBeDisabled();
	}}
/>

<Story
	name="Wrong role shows a specific SP hint"
	play={async ({ canvasElement }) => {
		const canvas = within(canvasElement);
		await choose(canvas, 'sp');
		await url(canvas, 'https://metadata.example.test/idp.xml');
		await canvas.findByText(t('sf.metadata.wrongRoleSp'));
		await expect(canvas.getByRole('button', { name: t('sf.create.save') })).toBeDisabled();
	}}
/>

<Story
	name="Failed metadata fetch shows a localized URL hint"
	play={async ({ canvasElement }) => {
		const canvas = within(canvasElement);
		await choose(canvas, 'sp');
		await url(canvas, 'https://metadata.example.test/fetch-failed.xml');
		await canvas.findByText(t('sf.metadata.fetchFailed'));
		await expect(canvas.getByRole('button', { name: t('sf.create.save') })).toBeDisabled();
	}}
/>

<Story
	name="Draft creation and editing stay L0 while activation asks for L2"
	play={async ({ canvasElement }) => {
		const canvas = within(canvasElement);
		const page = within(canvasElement.ownerDocument.body);
		await choose(canvas, 'sp');
		await url(canvas);
		await canvas.findByText('urn:synthetic:saml_sp');
		await expect(page.queryByRole('dialog', { name: t('stepUp.title') })).toBeNull();
		await userEvent.click(canvas.getByRole('button', { name: t('sf.create.save') }));
		await canvas.findByRole('heading', { name: t('af.general') });
		await expect(http.writes).toHaveLength(1);
		await expect(http.current().enabled).toBe(false);
		await expect(page.queryByRole('dialog', { name: t('stepUp.title') })).toBeNull();
		await change(canvas, t('sf.ours.acsUrl'), 'https://synthetic.example.test/draft-acs');
		await userEvent.click(canvas.getByRole('button', { name: t('common.save') }));
		await canvas.findByText(t('sf.live.saved'));
		await expect(http.writes).toHaveLength(2);
		await expect(page.queryByRole('dialog', { name: t('stepUp.title') })).toBeNull();
		const enable = canvas.getByRole('button', { name: t('sf.live.enable') });
		await waitFor(() => expect(enable).toBeEnabled());
		await userEvent.click(enable);
		const dialog = await page.findByRole('dialog', { name: t('stepUp.title') });
		await waitFor(() => expect(dialog).toBeVisible());
		await expect(dialog).toHaveTextContent('L2');
		await expect(http.current().enabled).toBe(false);
		await userEvent.click(within(dialog).getByRole('button', { name: t('common.cancel') }));
		await waitFor(() => expect(dialog).not.toBeVisible());
		await expect(http.writes).toHaveLength(2);
		await expect(http.current().enabled).toBe(false);
	}}
/>
