<script lang="ts">
	import type {
		AppSummary,
		ClientMappingChoice,
		EffectiveMapping,
		IdentityMappingClient,
		MappingSetSummary
	} from '$lib/api/identity-mapping';
	import { t } from '$lib/i18n/i18n.svelte';
	import Callout from '$lib/ui/patterns/Callout.svelte';
	import Card from '$lib/ui/patterns/Card.svelte';
	import DataTable from '$lib/ui/patterns/DataTable.svelte';
	import LoadingState from '$lib/ui/patterns/LoadingState.svelte';
	import PageHeader from '$lib/ui/patterns/PageHeader.svelte';
	import Button from '$lib/ui/primitives/Button.svelte';
	import RadioGroup from '$lib/ui/primitives/RadioGroup.svelte';
	import Select from '$lib/ui/primitives/Select.svelte';
	import { Draft } from '$lib/ui/save/draft.svelte';
	import SaveScope from '$lib/ui/save/SaveScope.svelte';
	import Page from '$lib/ui/templates/Page.svelte';
	import ChainList from './ChainList.svelte';
	import SourceLabel from './SourceLabel.svelte';

	/**
	 * MAP-03: one app's choice — follow the tenant default (not set), a set of its own
	 * (クライアント指定), or no mapping (使わない, `{mode:'none'}`). What applies now comes from the
	 * effective API; what each choice would give comes from the API's preview of that choice, so
	 * "follow" and "not used" are told apart by what they actually do, not by wording alone.
	 */
	interface Props {
		client: IdentityMappingClient;
		tenantId: string;
		clientId: string;
	}

	let { client, tenantId, clientId }: Props = $props();

	type Mode = 'follow' | 'own' | 'none';
	interface Choice {
		mode: Mode;
		setId: string;
	}

	let app = $state<AppSummary | null>(null);
	let effective = $state<EffectiveMapping | null>(null);
	let sets = $state<MappingSetSummary[]>([]);
	let loadError = $state(false);
	let draft = $state<Draft<Choice> | null>(null);
	let wouldFollow = $state<EffectiveMapping | null>(null);
	let wouldNone = $state<EffectiveMapping | null>(null);
	let wouldOwn = $state<EffectiveMapping | null>(null);
	const would = (mode: Mode) =>
		mode === 'follow' ? wouldFollow : mode === 'none' ? wouldNone : wouldOwn;

	const fromApi = (choice: ClientMappingChoice): Choice =>
		choice === null
			? { mode: 'follow', setId: '' }
			: 'mode' in choice
				? { mode: 'none', setId: '' }
				: { mode: 'own', setId: choice.fieldMappingSetId };
	const toApi = (choice: Choice): ClientMappingChoice =>
		choice.mode === 'follow'
			? null
			: choice.mode === 'none'
				? { mode: 'none' }
				: { fieldMappingSetId: choice.setId };

	/** Each load counts up; an answer for an older app or tenant is dropped. */
	let generation = 0;

	async function load() {
		const mine = ++generation;
		const ids = { tenantId, clientId };
		loadError = false;
		effective = null;
		draft = null;
		wouldOwn = null;
		try {
			const [apps, now, list, follow, none] = await Promise.all([
				client.apps(ids.tenantId),
				client.effective(ids.tenantId, ids.clientId),
				client.sets(ids.tenantId),
				client.previewChoice(ids.tenantId, ids.clientId, null),
				client.previewChoice(ids.tenantId, ids.clientId, { mode: 'none' })
			]);
			if (mine !== generation) return;
			app = apps.find((a) => a.client_id === ids.clientId) ?? null;
			effective = now;
			sets = list.sets.filter((s) => s.enabled);
			wouldFollow = follow;
			wouldNone = none;
			draft = new Draft(fromApi(app?.identity_mapping ?? null));
		} catch {
			if (mine === generation) loadError = true;
		}
	}

	$effect(() => {
		void load();
	});

	// What the chosen set would give, asked again whenever another set is chosen.
	$effect(() => {
		const setId = draft?.value.setId;
		const asked = { tenantId, clientId, setId, generation };
		wouldOwn = null;
		if (!setId) return;
		client
			.previewChoice(asked.tenantId, asked.clientId, { fieldMappingSetId: setId })
			.then((own) => {
				if (asked.generation === generation && draft?.value.setId === setId) wouldOwn = own;
			})
			.catch(() => {});
	});

	async function save(value: Choice) {
		if (value.mode === 'own' && !value.setId) throw new Error(t('mc.app.setRequired'));
		const mine = generation;
		await client.setAppChoice(tenantId, clientId, toApi(value));
		const now = await client.effective(tenantId, clientId);
		if (mine === generation) effective = now;
	}

	const rows = $derived([
		{ mode: 'follow' as const, label: t('mc.app.follow') },
		{ mode: 'own' as const, label: t('mc.app.own') },
		{ mode: 'none' as const, label: t('mc.app.none') }
	]);
</script>

<Page>
	<PageHeader
		title={t('mc.app.title', { app: app?.name ?? clientId })}
		description={t('mc.app.desc')}
	/>

	{#if loadError}
		<Callout tone="warning" live>
			{t('mc.loadFailed')}
			<Button variant="secondary" size="sm" onclick={load}>{t('mc.retry')}</Button>
		</Callout>
	{:else if !effective || !draft}
		<LoadingState label={t('mc.loading')} />
	{:else}
		<Card title={t('mc.app.current')}>
			<div class="form">
				<SourceLabel selection={effective.selection} labelled />
				<ChainList chain={effective.chain} selection={effective.selection} />
			</div>
		</Card>

		<SaveScope {draft} onsave={save}>
			<Card title={t('mc.app.choice')}>
				<div class="form">
					<RadioGroup
						label={t('mc.app.choice')}
						field="mode"
						options={[
							{
								value: 'follow',
								label: t('mc.app.follow'),
								description: t('mc.app.follow.desc')
							},
							{ value: 'own', label: t('mc.app.own'), description: t('mc.app.own.desc') },
							{ value: 'none', label: t('mc.app.none'), description: t('mc.app.none.desc') }
						]}
						bind:value={draft!.value.mode}
					/>
					{#if draft!.value.mode === 'own'}
						<Select
							label={t('mc.app.set')}
							field="setId"
							placeholder={t('mc.ro.choose')}
							required
							options={sets.map((s) => ({ value: s.id, label: s.display_name ?? s.id }))}
							bind:value={draft!.value.setId}
						/>
					{/if}
				</div>
			</Card>

			<Card title={t('mc.app.would')} flush>
				<DataTable
					caption={t('mc.app.would')}
					columns={[
						{ key: 'choice', label: t('mc.app.choice'), width: '32%' },
						{ key: 'effect', label: t('mc.effective') }
					]}
					{rows}
					rowKey={(row) => row.mode}
					rowChanged={(row) => row.mode === draft!.value.mode && draft!.changed('mode')}
				>
					{#snippet cell(row, column)}
						{#if column.key === 'choice'}
							<span class:chosen={row.mode === draft!.value.mode}>{row.label}</span>
						{:else if would(row.mode)}
							<SourceLabel selection={would(row.mode)!.selection} />
						{:else}
							<span class="muted">{t('mc.app.setRequired')}</span>
						{/if}
					{/snippet}
				</DataTable>
			</Card>
		</SaveScope>
	{/if}
</Page>

<style>
	.form {
		display: flex;
		flex-direction: column;
		gap: var(--space-field);
	}

	.chosen {
		font-weight: var(--fw-semibold);
	}

	.muted {
		color: var(--text-secondary);
	}
</style>
