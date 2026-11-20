<script module lang="ts">
	import { defineMeta } from '@storybook/addon-svelte-csf';
	import { expect, fn, userEvent, waitFor, within } from 'storybook/test';
	import {
		createFakeFederationSources,
		MOCK_FEDERATION_CERTIFICATE,
		MOCK_FEDERATION_FINGERPRINT,
		MOCK_FEDERATION_SOURCES
	} from '#lib/api/fake/federation-sources-fake.js';
	import { t } from '#lib/i18n/i18n.svelte.js';
	import { fingerprintDisplay } from '../federation-model';
	import { fingerprintText } from '../federation-fingerprint.fixture';
	import FederationConnectionPage from './FederationConnectionPage.svelte';

	const { Story } = defineMeta({
		title: 'Pages/Service flows/Federation connection',
		component: FederationConnectionPage,
		tags: ['draft'],
		parameters: {
			layout: 'fullscreen',
			docs: {
				description: {
					component:
						"A SAML federation's own page: whether it is keeping up, who takes part, who is set aside, its entities (searched and paged on the server), what it is trusted on, and deleting it. Exceptions, roles and trust are saved together from the bar."
				}
			}
		}
	});

	type Canvas = ReturnType<typeof within>;
	const SETS = [
		{ value: 'map-tenant-default', label: 'Tenant default' },
		{ value: 'map-other', label: 'Other set' }
	];
	const [healthy, lapsed] = MOCK_FEDERATION_SOURCES;
	const ID = 'test-federation';

	/** A page over its own fake, so each story reads and writes only what it made. */
	function page(
		options: {
			sources?: Parameters<typeof createFakeFederationSources>[0] extends infer O
				? O extends { sources?: infer S }
					? S
					: never
				: never;
			conflictOnSave?: boolean;
			id?: string;
			canEdit?: boolean;
			canRefresh?: boolean;
			canMaterialize?: boolean;
		} = {}
	) {
		const client = createFakeFederationSources({
			sources: options.sources ?? MOCK_FEDERATION_SOURCES,
			conflictOnSave: options.conflictOnSave
		});
		const onback = fn();
		const onnavigate = fn(async (_path: string) => {});
		return {
			client,
			onback,
			onnavigate,
			args: {
				id: options.id ?? ID,
				client,
				canEdit: options.canEdit ?? true,
				canRefresh: options.canRefresh ?? true,
				canMaterialize: options.canMaterialize ?? true,
				loadMappingSets: async () => SETS,
				onback,
				onnavigate
			}
		};
	}

	/** The table row of an entity (the exception list names the same entity too, so the table is asked). */
	const row = async (canvas: Canvas, entityId: string) =>
		(
			await within(canvas.getByRole('table', { name: t('sf.fed.entities.title') })).findByText(
				entityId
			)
		).closest('tr') as HTMLElement;
	const search = (canvas: Canvas) => canvas.getByLabelText(t('sf.fed.entities.search'));
	const save = (canvas: Canvas) => canvas.getByRole('button', { name: t('common.save') });

	const healthyPage = page();
	const lapsedPage = page({ id: 'lapsed-federation' });
	const failingPage = page({
		sources: [
			{
				...healthy,
				status: {
					...healthy.status!,
					sourceState: 'error',
					consecutiveFailures: 3,
					lastErrorCode: 'metadata_fetch_failed'
				}
			}
		]
	});
	const viewerPage = page({ canEdit: false, canRefresh: false, canMaterialize: false });
	const pagingPage = page();
	const excludePage = page();
	const conflictPage = page({ conflictOnSave: true });
	const rolePage = page({ sources: [{ ...healthy, roles: ['saml_sp'], idpMappingSetId: '' }] });
	const certPage = page();
	const deletePage = page();
	const raceFake = page();
	const refreshPage = page({ id: 'lapsed-federation' });
	const ambiguousPage = page();
	const spPage = page();
	const noMaterializePage = page({ canMaterialize: false });
</script>

<Story
	name="Healthy: signature, validity, entities and recent updates"
	args={healthyPage.args}
	play={async ({ canvasElement }) => {
		const canvas = within(canvasElement);
		await canvas.findByRole('heading', { name: 'Test federation' });
		await expect(canvas.getAllByText(t('sf.fed.status.active')).length).toBeGreaterThan(0);
		await expect(canvas.getByText(t('sf.fed.verification.verified'))).toBeVisible();
		await expect(canvas.getByText(/14 days left/)).toBeVisible();
		await expect(canvas.getByText(/1,200 \(3 set aside\)/)).toBeVisible();
		await expect(canvas.getByText(/\+4/)).toBeVisible();
		await expect(canvas.getByText(/Failed \(metadata_fetch_failed\)/)).toBeVisible();
		await expect(canvas.queryByText(t('sf.fed.statusCard.expiredTitle'))).toBeNull();
	}}
/>

<Story
	name="Run-out metadata says so first"
	args={lapsedPage.args}
	play={async ({ canvasElement }) => {
		const canvas = within(canvasElement);
		await canvas.findByText(t('sf.fed.statusCard.expiredTitle'));
		await expect(canvas.getAllByText(t('sf.fed.status.expired')).length).toBeGreaterThan(0);
		await expect(canvas.getByText(/expired 2 days ago/)).toBeVisible();
	}}
/>

<Story
	name="Failing fetches keep the old metadata and say why"
	args={failingPage.args}
	play={async ({ canvasElement }) => {
		const canvas = within(canvasElement);
		await canvas.findByText(t('sf.fed.statusCard.failedTitle'));
		await expect(canvas.getByText('metadata_fetch_failed', { selector: 'code' })).toBeVisible();
		await expect(canvas.getAllByText(t('sf.fed.status.refreshFailed')).length).toBeGreaterThan(0);
	}}
/>

<Story
	name="Read-only: nothing to change, update, delete or make"
	args={viewerPage.args}
	play={async ({ canvasElement }) => {
		const canvas = within(canvasElement);
		await canvas.findByText(t('sf.fed.readonly'));
		await expect(canvas.queryByRole('button', { name: t('sf.fed.statusCard.refresh') })).toBeNull();
		await expect(canvas.queryByRole('button', { name: t('sf.fed.delete.button') })).toBeNull();
		await canvas.findByText('https://sp.excluded-2.example/shibboleth');
		await expect(canvas.queryByRole('button', { name: t('sf.fed.entities.include') })).toBeNull();
		await expect(canvas.queryByRole('button', { name: t('sf.fed.entities.exclude') })).toBeNull();
		await expect(
			canvas.queryByRole('button', { name: t('sf.fed.entities.materialize') })
		).toBeNull();
		await expect(canvas.getByRole('switch', { name: t('sf.fed.role.sp') })).toBeDisabled();
	}}
/>

<Story
	name="A federation of 1,200 entities is searched and paged on the server"
	args={pagingPage.args}
	play={async ({ canvasElement }) => {
		const canvas = within(canvasElement);
		await canvas.findByText(/1–25 of 1,200/);
		await expect(canvas.getAllByRole('row').length).toBeLessThanOrEqual(26 + 1);
		await userEvent.click(canvas.getByRole('button', { name: t('sf.fed.entities.next') }));
		await canvas.findByText(/26–50 of 1,200/);
		await userEvent.click(canvas.getByRole('button', { name: t('sf.fed.entities.previous') }));
		await canvas.findByText(/1–25 of 1,200/);
		await userEvent.type(search(canvas), 'sp.excluded-2.example');
		await canvas.findByText(/1–1 of 1\b/);
		await expect(await row(canvas, 'https://sp.excluded-2.example/shibboleth')).toBeVisible();
		await expect(canvas.getByRole('button', { name: t('sf.fed.entities.next') })).toBeDisabled();
		// A state filter narrows to what is set aside (the three that were).
		await userEvent.clear(search(canvas));
		await userEvent.selectOptions(
			canvas.getByRole('combobox', { name: t('sf.fed.entities.col.state') }),
			'excluded'
		);
		await canvas.findByText(/1–3 of 3/);
	}}
/>

<Story
	name="Setting an entity aside and taking one back, saved together"
	args={excludePage.args}
	play={async ({ canvasElement }) => {
		const canvas = within(canvasElement);
		await canvas.findByText(/of 1,200/);
		await userEvent.type(search(canvas), 'idp.inst-4.example');
		const target = await row(canvas, 'https://idp.inst-4.example/idp/shibboleth');
		await userEvent.click(
			within(target).getByRole('button', { name: t('sf.fed.entities.exclude') })
		);
		await expect(within(target).getByText(t('sf.fed.entities.state.excluded'))).toBeVisible();
		// The change is held until saved; the exception list now holds it.
		await expect(excludePage.client.calls.updated).toHaveLength(0);
		await userEvent.clear(search(canvas));
		await userEvent.type(search(canvas), 'sp.excluded-1.example');
		const back = await row(canvas, 'https://sp.excluded-1.example/shibboleth');
		await userEvent.click(within(back).getByRole('button', { name: t('sf.fed.entities.include') }));
		await userEvent.click(save(canvas));
		await waitFor(() => expect(excludePage.client.calls.updated).toHaveLength(1));
		const { payload, expectedUpdatedAt } = excludePage.client.calls.updated[0].input as {
			payload: {
				exceptions: { excludedEntityIds: string[] };
				runtimeResolution: { roles: string[] };
			};
			expectedUpdatedAt: number;
		};
		await expect([...payload.exceptions.excludedEntityIds].sort()).toEqual([
			'https://idp.inst-4.example/idp/shibboleth',
			'https://sp.excluded-2.example/shibboleth',
			'https://sp.excluded-3.example/shibboleth'
		]);
		await expect(payload.runtimeResolution.roles).toEqual(['saml_idp', 'saml_sp']);
		await expect(expectedUpdatedAt).toBe(healthy.updatedAt);
		await waitFor(() => expect(canvas.getByText(/1,200 \(3 set aside\)/)).toBeVisible());
	}}
/>

<Story
	name="Changed by someone else: the save is refused and offered as a reload"
	args={conflictPage.args}
	play={async ({ canvasElement }) => {
		const canvas = within(canvasElement);
		await canvas.findByText(/of 1,200/);
		await userEvent.type(search(canvas), 'idp.inst-4.example');
		const target = await row(canvas, 'https://idp.inst-4.example/idp/shibboleth');
		await userEvent.click(
			within(target).getByRole('button', { name: t('sf.fed.entities.exclude') })
		);
		await userEvent.click(save(canvas));
		await canvas.findByText(t('sf.live.conflict'));
		// What was typed is kept until the reload is asked for.
		await expect(within(target).getByText(t('sf.fed.entities.state.excluded'))).toBeVisible();
		await userEvent.click(canvas.getByRole('button', { name: t('sf.live.reload') }));
		await waitFor(() => expect(canvas.queryByText(t('sf.live.conflict'))).toBeNull());
	}}
/>

<Story
	name="A role that is turned on needs its mapping set before it can be saved"
	args={rolePage.args}
	play={async ({ canvasElement }) => {
		const canvas = within(canvasElement);
		await canvas.findByRole('heading', { name: 'Test federation' });
		await userEvent.click(canvas.getByRole('switch', { name: t('sf.fed.role.idp') }));
		await canvas.findByText(t('sf.fed.error.idpMapping'));
		await userEvent.click(save(canvas));
		await expect(rolePage.client.calls.updated).toHaveLength(0);
		const set = canvas.getByRole('combobox', { name: t('sf.fed.mappingSet.idp') });
		await waitFor(() => expect(set).toBeEnabled());
		await userEvent.selectOptions(set, 'map-other');
		await userEvent.click(save(canvas));
		await waitFor(() => expect(rolePage.client.calls.updated).toHaveLength(1));
		await expect(rolePage.client.calls.updated[0].input).toMatchObject({
			payload: {
				runtimeResolution: { roles: ['saml_idp', 'saml_sp'], idpFieldMappingSetId: 'map-other' }
			}
		});
	}}
/>

<Story
	name="A certificate is added with its fingerprint and saved"
	args={certPage.args}
	play={async ({ canvasElement }) => {
		const canvas = within(canvasElement);
		await canvas.findByRole('heading', { name: 'Test federation' });
		// The one it already has: a repeat is not added twice.
		await userEvent.click(canvas.getByRole('textbox', { name: t('sf.fed.cert.paste') }));
		await userEvent.paste(MOCK_FEDERATION_CERTIFICATE);
		await userEvent.click(canvas.getByRole('button', { name: t('sf.fed.cert.add') }));
		await expect(
			canvas.getAllByText(fingerprintText(fingerprintDisplay(MOCK_FEDERATION_FINGERPRINT)))
		).toHaveLength(1);
		await userEvent.click(
			canvas.getByRole('button', { name: new RegExp(`^${t('sf.fed.cert.remove')}`) })
		);
		await expect(
			canvas.queryByText(fingerprintText(fingerprintDisplay(MOCK_FEDERATION_FINGERPRINT)))
		).toBeNull();
		await userEvent.click(canvas.getByRole('textbox', { name: t('sf.fed.cert.paste') }));
		await userEvent.paste(MOCK_FEDERATION_CERTIFICATE);
		await userEvent.click(canvas.getByRole('button', { name: t('sf.fed.cert.add') }));
		await canvas.findByText(fingerprintText(fingerprintDisplay(MOCK_FEDERATION_FINGERPRINT)));
	}}
/>

<Story
	name="Deleting warns about the connections that stay"
	args={deletePage.args}
	play={async ({ canvasElement }) => {
		const canvas = within(canvasElement);
		await canvas.findByRole('heading', { name: 'Test federation' });
		await userEvent.click(canvas.getByRole('button', { name: t('sf.fed.delete.button') }));
		const dialog = await canvas.findByRole('dialog');
		await expect(
			within(dialog).getByText(/1 connections made from its entities stay/)
		).toBeVisible();
		await userEvent.click(within(dialog).getByRole('button', { name: t('sf.fed.delete.button') }));
		await waitFor(() => expect(deletePage.client.calls.removed).toEqual([ID]));
		await waitFor(() => expect(deletePage.onback).toHaveBeenCalled());
	}}
/>

<Story
	name="Update now fetches and reads the standing again"
	args={refreshPage.args}
	play={async ({ canvasElement }) => {
		const canvas = within(canvasElement);
		await canvas.findByText(t('sf.fed.statusCard.expiredTitle'));
		await userEvent.click(canvas.getByRole('button', { name: t('sf.fed.statusCard.refresh') }));
		await waitFor(() => expect(refreshPage.client.calls.refreshed).toEqual(['lapsed-federation']));
		await waitFor(() => expect(canvas.queryByText(t('sf.fed.statusCard.expiredTitle'))).toBeNull());
		await expect(lapsed.status?.sourceState).toBe('expired');
		// The fetch moved the version; a save after it is still accepted.
		await canvas.findByText(/of 480|of 1,200/);
		const first = canvas.getAllByRole('button', { name: t('sf.fed.entities.exclude') })[0];
		await userEvent.click(first);
		await userEvent.click(save(canvas));
		await waitFor(() => expect(refreshPage.client.calls.updated).toHaveLength(1));
		await expect(canvas.queryByText(t('sf.live.conflict'))).toBeNull();
	}}
/>

<Story
	name="An entity that is both: pick which connection to make, then open it"
	args={ambiguousPage.args}
	play={async ({ canvasElement }) => {
		const canvas = within(canvasElement);
		await canvas.findByText(/of 1,200/);
		await userEvent.type(search(canvas), 'sp.inst-5.example');
		const target = await row(canvas, 'https://sp.inst-5.example/shibboleth');
		await userEvent.click(
			within(target).getByRole('button', { name: t('sf.fed.entities.materialize') })
		);
		const dialog = await canvas.findByRole('dialog');
		await userEvent.click(
			within(dialog).getByRole('radio', { name: t('sf.fed.materialize.asIdp') })
		);
		await userEvent.click(
			within(dialog).getByRole('button', { name: t('sf.fed.materialize.submit') })
		);
		await waitFor(() => expect(ambiguousPage.client.calls.materialized).toHaveLength(1));
		await expect(ambiguousPage.client.calls.materialized[0].input).toMatchObject({
			entityId: 'https://sp.inst-5.example/shibboleth',
			providerType: 'idp',
			fieldMappingSetId: 'map-tenant-default'
		});
		await waitFor(() =>
			expect(ambiguousPage.onnavigate).toHaveBeenCalledWith(
				'/admin/applications/all/idp/saml-materialized-1'
			)
		);
	}}
/>

<Story
	name="A service that is set aside can still be given its own connection"
	args={spPage.args}
	play={async ({ canvasElement }) => {
		const canvas = within(canvasElement);
		await canvas.findByText(/of 1,200/);
		await userEvent.type(search(canvas), 'sp.excluded-1.example');
		const target = await row(canvas, 'https://sp.excluded-1.example/shibboleth');
		await userEvent.click(
			within(target).getByRole('button', { name: t('sf.fed.entities.materialize') })
		);
		const dialog = await canvas.findByRole('dialog');
		await expect(within(dialog).getByText(t('sf.fed.materialize.excluded'))).toBeVisible();
		// Its role is known: no choice of kind.
		await expect(within(dialog).queryByRole('radio')).toBeNull();
		await userEvent.click(
			within(dialog).getByRole('button', { name: t('sf.fed.materialize.submit') })
		);
		await waitFor(() => expect(spPage.client.calls.materialized).toHaveLength(1));
		await expect(spPage.client.calls.materialized[0].input).toMatchObject({ providerType: 'sp' });
		// The row now says so (no longer a participant or an exclusion).
		await waitFor(async () =>
			expect(
				within(
					(await row(canvas, 'https://sp.excluded-1.example/shibboleth')) as HTMLElement
				).getByText(t('sf.fed.entities.state.explicitLink'))
			).toBeVisible()
		);
	}}
/>

<Story
	name="Without permission to create connections, no button to make one"
	args={noMaterializePage.args}
	play={async ({ canvasElement }) => {
		const canvas = within(canvasElement);
		await canvas.findByText(/of 1,200/);
		await expect(
			canvas.queryByRole('button', { name: t('sf.fed.entities.materialize') })
		).toBeNull();
		await expect(
			canvas.getAllByRole('button', { name: t('sf.fed.entities.exclude') }).length
		).toBeGreaterThan(0);
	}}
/>

<Story
	name="Update now with unsaved edits does not hide a change made by someone else"
	args={raceFake.args}
	play={async ({ canvasElement }) => {
		const canvas = within(canvasElement);
		await canvas.findByText(/of 1,200/);
		await userEvent.type(search(canvas), 'idp.inst-4.example');
		const target = await row(canvas, 'https://idp.inst-4.example/idp/shibboleth');
		await userEvent.click(
			within(target).getByRole('button', { name: t('sf.fed.entities.exclude') })
		);
		// Another administrator saves a different change in the meantime.
		const current = await raceFake.client.get(ID);
		await raceFake.client.update(ID, {
			sourceKey: current.sourceKey,
			name: 'Renamed elsewhere',
			lifecycleState: current.lifecycleState,
			payload: current.payload,
			expectedUpdatedAt: current.updatedAt
		});
		await userEvent.click(canvas.getByRole('button', { name: t('sf.fed.statusCard.refresh') }));
		await canvas.findByText(t('sf.live.conflict'));
		await userEvent.click(save(canvas));
		await waitFor(() =>
			expect(canvas.getAllByText(t('sf.live.conflict')).length).toBeGreaterThan(0)
		);
		await expect(raceFake.client.calls.updated).toHaveLength(1);
	}}
/>
