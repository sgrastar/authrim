<script lang="ts">
	import { onMount } from 'svelte';
	import type {
		DestinationKind,
		DestinationProfileSaved,
		DestinationProfilesClient
	} from '#lib/api/destination-profiles.js';
	import type { MappingDestinationProfile } from '#lib/api/mapping-set.js';
	import type {
		SourceKind,
		SourceProfile,
		SourceProfileSaved,
		SourceProfilesClient
	} from '#lib/api/source-profiles.js';
	import { t, type MessageKey } from '#lib/i18n/i18n.svelte.js';
	import DestinationProfileEditor from '#lib/pages/service-flows/destination-profile/DestinationProfileEditor.svelte';
	import LeaveGuard from '#lib/pages/service-flows/LeaveGuard.svelte';
	import ConfirmDialog from '#lib/ui/patterns/ConfirmDialog.svelte';
	import Callout from '#lib/ui/patterns/Callout.svelte';
	import Card from '#lib/ui/patterns/Card.svelte';
	import DataTable from '#lib/ui/patterns/DataTable.svelte';
	import LoadingState from '#lib/ui/patterns/LoadingState.svelte';
	import PageHeader from '#lib/ui/patterns/PageHeader.svelte';
	import ActionMenu, { type MenuAction } from '#lib/ui/primitives/ActionMenu.svelte';
	import Badge from '#lib/ui/primitives/Badge.svelte';
	import Button from '#lib/ui/primitives/Button.svelte';
	import Page from '#lib/ui/templates/Page.svelte';
	import SourceProfileEditor from './SourceProfileEditor.svelte';

	/**
	 * The tenant's output sources (what Authrim sends to an app or service: SAML attributes, OIDC
	 * claims) and input sources (what comes in: SCIM attributes, CSV columns): listed together,
	 * made and changed with the same editor a service flow opens in place, and deleted. A save
	 * switches the profile on; there are no versions or releases here.
	 */
	interface Props {
		tenantId: string;
		destinations: DestinationProfilesClient;
		sources: SourceProfilesClient;
		/** The profiles may be made, changed and deleted. */
		canWrite: boolean;
	}
	let { tenantId, destinations, sources, canWrite }: Props = $props();

	type Row = {
		id: string;
		side: 'out' | 'in';
		kind: DestinationKind | SourceKind;
		name: string;
		active: boolean;
		destination?: MappingDestinationProfile;
		source?: SourceProfile;
	};
	let phase = $state<'loading' | 'ready' | 'failed'>('loading');
	let outputs = $state<MappingDestinationProfile[]>([]);
	let inputs = $state<SourceProfile[]>([]);
	/** What is open: the list, or an editor for one side and kind (a profile when it is changed). */
	let editor = $state<
		| { side: 'out'; kind: DestinationKind; profile?: MappingDestinationProfile }
		| { side: 'in'; kind: SourceKind; profile?: SourceProfile }
		| null
	>(null);
	let notice = $state('');
	let editorState = $state({ dirty: false, saving: false });
	let deleting = $state<Row | null>(null);
	let deleteFailure = $state('');
	let deletingBusy = $state(false);

	async function load() {
		try {
			[outputs, inputs] = await Promise.all([
				destinations.listAll(tenantId),
				sources.list(tenantId)
			]);
			phase = 'ready';
		} catch {
			phase = 'failed';
		}
	}
	onMount(() => void load());

	const KIND_LABEL: Record<string, MessageKey> = {
		saml: 'pf.kind.saml',
		oidc: 'pf.kind.oidc',
		scim: 'pf.kind.scim',
		csv: 'pf.kind.csv'
	};
	const rows = $derived<Row[]>([
		...outputs
			.filter((row) => row.destinationType === 'saml' || row.destinationType === 'oidc')
			.map((row) => ({
				id: `out:${row.id}`,
				side: 'out' as const,
				kind: row.destinationType as DestinationKind,
				name: row.displayName,
				active: row.lifecycleState === 'active',
				destination: row
			})),
		...inputs
			.filter((row) => row.sourceType === 'scim' || row.sourceType === 'csv')
			.map((row) => ({
				id: `in:${row.id}`,
				side: 'in' as const,
				kind: row.sourceType as SourceKind,
				name: row.displayName,
				active: row.lifecycleState === 'active',
				source: row
			}))
	]);
	const columns = $derived([
		{ key: 'name', label: t('pf.col.name') },
		{ key: 'kind', label: t('pf.col.kind'), width: '240px' },
		{ key: 'state', label: t('pf.col.state'), width: '140px' },
		{ key: 'actions', label: t('pf.col.actions'), width: '72px', hideLabel: true }
	]);

	function openEditor(row: Row) {
		notice = '';
		editorState = { dirty: false, saving: false };
		if (row.side === 'out' && row.destination)
			editor = { side: 'out', kind: row.kind as DestinationKind, profile: row.destination };
		else if (row.source) editor = { side: 'in', kind: row.kind as SourceKind, profile: row.source };
	}
	function actionsOf(row: Row): MenuAction[] {
		if (!canWrite) return [];
		return [
			{ label: t('pf.edit'), onselect: () => openEditor(row) },
			// The server refuses (409) while a mapping set still reads from the profile; the dialog
			// then shows its reason instead of closing.
			{
				label: t('pf.delete'),
				danger: true,
				onselect: () => {
					deleteFailure = '';
					deleting = row;
				}
			}
		];
	}
	async function saved(_result: DestinationProfileSaved | SourceProfileSaved) {
		editor = null;
		editorState = { dirty: false, saving: false };
		notice = t('pf.saved');
		await load();
	}
	async function confirmDelete() {
		const row = deleting;
		if (!row) return;
		deletingBusy = true;
		deleteFailure = '';
		try {
			if (row.side === 'out' && row.destination)
				await destinations.remove(tenantId, row.destination.id);
			else if (row.source) await sources.remove(tenantId, row.source.id);
			deleting = null;
			notice = t('pf.deleted');
			await load();
		} catch (error) {
			deleteFailure =
				error instanceof Error && error.message ? error.message : t('pf.deleteFailed');
		} finally {
			deletingBusy = false;
		}
	}
	function start(side: 'out' | 'in', kind: DestinationKind | SourceKind) {
		notice = '';
		editorState = { dirty: false, saving: false };
		editor =
			side === 'out'
				? { side: 'out', kind: kind as DestinationKind }
				: { side: 'in', kind: kind as SourceKind };
	}
</script>

<LeaveGuard dirty={editor !== null && editorState.dirty} />
<Page>
	<PageHeader title={t('pf.title')} description={t('pf.description')}>
		{#snippet actions()}
			{#if canWrite && !editor}
				<Button variant="secondary" size="sm" onclick={() => start('out', 'saml')}
					>{t('pf.create.saml')}</Button
				>
				<Button variant="secondary" size="sm" onclick={() => start('out', 'oidc')}
					>{t('pf.create.oidc')}</Button
				>
				<Button variant="secondary" size="sm" onclick={() => start('in', 'scim')}
					>{t('pf.create.scim')}</Button
				>
				<Button variant="secondary" size="sm" onclick={() => start('in', 'csv')}
					>{t('pf.create.csv')}</Button
				>
			{/if}
		{/snippet}
	</PageHeader>

	{#if notice}<Callout tone="info" live>{notice}</Callout>{/if}
	{#if editor}
		<Card>
			{#if editor.side === 'out'}
				{#key editor.profile?.id ?? 'new'}
					<DestinationProfileEditor
						protocol={editor.kind}
						{tenantId}
						client={destinations}
						profiles={outputs.filter((row) => row.destinationType === editor?.kind)}
						profile={editor.profile}
						usageUnknown={editor.profile !== undefined}
						onstate={(state) => (editorState = state)}
						onsaved={saved}
						oncancel={() => (editor = null)}
					/>
				{/key}
			{:else}
				{#key editor.profile?.id ?? 'new'}
					<SourceProfileEditor
						kind={editor.kind}
						{tenantId}
						client={sources}
						profiles={inputs.filter((row) => row.sourceType === editor?.kind)}
						profile={editor.profile}
						onstate={(state) => (editorState = state)}
						onsaved={saved}
						oncancel={() => (editor = null)}
					/>
				{/key}
			{/if}
		</Card>
	{:else if phase === 'loading'}
		<LoadingState label={t('common.loading')} />
	{:else if phase === 'failed'}
		<Callout tone="warning" live>
			{t('pf.loadFailed')}
			<Button size="sm" onclick={load}>{t('common.retry')}</Button>
		</Callout>
	{:else}
		<Card flush>
			<DataTable {columns} {rows} rowKey={(row) => row.id} caption={t('pf.title')} minWidth="0">
				{#snippet cell(row, column)}
					{#if column.key === 'name'}
						<strong>{row.name}</strong>
					{:else if column.key === 'kind'}
						<Badge tone="neutral">{t(KIND_LABEL[row.kind])}</Badge>
					{:else if column.key === 'state'}
						<Badge tone={row.active ? 'success' : 'warning'} dot
							>{t(row.active ? 'pf.state.active' : 'pf.state.draft')}</Badge
						>
					{:else if column.key === 'actions'}
						{@const actions = actionsOf(row)}
						{#if actions.length > 0}
							<ActionMenu size="sm" label={t('pf.actionsFor', { name: row.name })} {actions} />
						{/if}
					{/if}
				{/snippet}
				{#snippet empty()}{t('pf.empty')}{/snippet}
			</DataTable>
		</Card>
	{/if}
</Page>

<ConfirmDialog
	open={deleting !== null}
	title={t('pf.deleteTitle')}
	body={deleteFailure || t('pf.deleteBody', { name: deleting?.name ?? '' })}
	confirmLabel={t('pf.delete')}
	tone="danger"
	busy={deletingBusy}
	onconfirm={() => void confirmDelete()}
	oncancel={() => (deleting = null)}
/>
