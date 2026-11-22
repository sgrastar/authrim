<script lang="ts">
	import type { SetChangePreview, TestUser } from '#lib/api/identity-mapping.js';
	import { i18n, t } from '#lib/i18n/i18n.svelte.js';
	import { formatNumber } from '#lib/ui/format.js';
	import Callout from '#lib/ui/patterns/Callout.svelte';
	import Card from '#lib/ui/patterns/Card.svelte';
	import DataTable from '#lib/ui/patterns/DataTable.svelte';
	import MappingEditor from '#lib/ui/patterns/MappingEditor.svelte';
	import type { Mapping, MappingField } from '#lib/ui/patterns/mapping-model.js';
	import Button from '#lib/ui/primitives/Button.svelte';
	import Select from '#lib/ui/primitives/Select.svelte';
	import IconButton from '#lib/ui/primitives/IconButton.svelte';
	import TitleEditor from '#lib/ui/patterns/TitleEditor.svelte';
	import { changeText, heldBackText } from './labels';
	import SourceLabel from './SourceLabel.svelte';

	/**
	 * The mapping set's screen: its claim mapping, and "See the changes" (what each app that uses
	 * the set would receive). It only draws: the Mapping sets page and a connection's mapping node
	 * both give it what they have read and answer its check, so the two look and read the same.
	 */
	interface Props {
		title: string;
		description?: string;
		sources: readonly MappingField[];
		targets: readonly MappingField[];
		mappings: Mapping[];
		/** The set the check is about (names where each app takes its set from). */
		setId: string;
		/** Test users whose made-up values can be compared; none: the sample is not offered. */
		users?: TestUser[];
		sample?: string;
		preview: SetChangePreview | null;
		/** The draft changed since the answer was asked for. */
		stale?: boolean;
		checking?: boolean;
		actionError?: string;
		/** The draft differs from what is saved. */
		dirty: boolean;
		/** A new set has nothing saved to check against: only its mapping is shown. */
		checkable?: boolean;
		/** The mapping holds something that cannot be saved. */
		invalid?: boolean;
		/** A line under an attribute's name in the open row of the mapping (see MappingEditor). */
		targetNote?: (key: string) => string | undefined;
		oncheck: () => void;
		/**
		 * The title is the mapping's name and can be changed in place (a mapping being made). Its
		 * words, and what is shown while there is no name yet.
		 */
		rename?: {
			onchange: (name: string) => void;
			placeholder: string;
			editLabel: string;
			label: string;
			hint: string;
			requiredMessage: string;
			doneLabel: string;
		};
	}

	let {
		title,
		description,
		sources,
		targets,
		mappings = $bindable(),
		setId,
		users = [],
		sample = $bindable(''),
		preview,
		stale = false,
		checking = false,
		actionError = '',
		dirty,
		checkable = true,
		invalid = $bindable(false),
		targetNote,
		oncheck,
		rename
	}: Props = $props();

	// A mapping with no name yet opens its title for naming; Done keeps the name, Cancel leaves it.
	let editing = $state(false);
	$effect(() => {
		if (rename && !title.trim()) editing = true;
	});

	const num = (n: number) => formatNumber(n, i18n.locale);
	const sampleLabel = $derived(
		users.find((u) => u.user_id === preview?.sample?.user_id)?.label ?? ''
	);
</script>

<Card>
	<div class="head">
		{#if rename && editing}
			<TitleEditor
				value={title}
				label={rename.label}
				hint={rename.hint}
				requiredMessage={rename.requiredMessage}
				maxlength={80}
				doneLabel={rename.doneLabel}
				oninput={(value) => rename.onchange(value)}
				ondone={(value) => {
					rename.onchange(value.trim());
					editing = false;
				}}
				oncancel={() => (editing = false)}
			/>
		{/if}
		<div class="head__row" class:is-hidden={rename && editing}>
			<h2 class="head__title">{title.trim() || rename?.placeholder || ''}</h2>
			{#if rename && !editing}
				<IconButton
					icon="pencil"
					size="sm"
					label={rename.editLabel}
					onclick={() => (editing = true)}
				/>
			{/if}
		</div>
		{#if description}<p class="head__desc">{description}</p>{/if}
	</div>
	<MappingEditor
		label={t('mc.ch.mapping')}
		direction="outbound"
		targetLabel={t('mc.ch.claim')}
		{sources}
		{targets}
		field="mappings"
		bind:mappings
		bind:invalid
		{targetNote}
	/>
</Card>

{#if checkable}
	<Card title={t('mc.ch.check')}>
		<div class="form">
			{#if users.length > 0}
				<div class="row">
					<Select
						label={t('mc.ch.sample')}
						hint={t('mc.ch.sampleHint')}
						options={[
							{ value: '', label: t('mc.ch.sampleNone') },
							...users.map((u) => ({ value: u.user_id, label: u.label }))
						]}
						bind:value={sample}
					/>
				</div>
			{/if}
			<div>
				<Button variant="secondary" loading={checking} onclick={oncheck}>{t('mc.ch.check')}</Button>
			</div>
			{#if actionError}
				<Callout tone="warning" live>{actionError}</Callout>
			{/if}
			{#if stale}
				<Callout tone="info">{t('mc.ch.stale')}</Callout>
			{/if}
			{#if preview && !preview.usage_complete}
				<Callout tone="warning">{t('mc.ch.incomplete')}</Callout>
			{/if}
			{#if preview && !dirty}
				<p class="muted">{t('mc.ch.noChanges')}</p>
			{/if}
		</div>
	</Card>

	{#if preview && !stale && preview.tenants}
		<Card title={t('mc.ch.tenants')} description={t('mc.ch.tenants.desc')} flush>
			<DataTable
				caption={t('mc.ch.tenants')}
				columns={[
					{ key: 'tenant', label: t('mc.ch.col.tenant') },
					{ key: 'apps', label: t('mc.ch.col.appsUsing'), width: '24%', align: 'end' }
				]}
				rows={preview.tenants}
				rowKey={(row) => row.tenant_id}
			>
				{#snippet cell(row, column)}
					{#if column.key === 'tenant'}
						<strong>{row.tenant_id}</strong>
					{:else if row.apps_using === null}
						<span class="muted">—</span>
					{:else}
						{num(row.apps_using)}
					{/if}
				{/snippet}
			</DataTable>
		</Card>
	{:else if preview && !stale}
		<Card title={t('mc.ch.result')} description={t('mc.ch.result.desc')} flush>
			<DataTable
				caption={t('mc.ch.result')}
				columns={[
					{ key: 'app', label: t('mc.ch.col.app'), width: '20%' },
					{ key: 'source', label: t('mc.ch.col.source'), width: '18%' },
					{ key: 'changes', label: t('mc.ch.col.changes') },
					{ key: 'held', label: t('mc.ch.col.heldBack'), width: '26%' }
				]}
				rows={preview.apps}
				rowKey={(app) => app.client_id}
			>
				{#snippet cell(app, column)}
					{#if column.key === 'app'}
						<strong>{app.name}</strong>
					{:else if column.key === 'source'}
						<SourceLabel selection={{ kind: 'bound', tier: app.tier, setId }} compact />
					{:else if column.key === 'changes'}
						{#if app.changes.length === 0}
							<span class="muted">{t('mc.ch.unchanged')}</span>
						{:else}
							<ul class="changes">
								{#each app.changes as change (change.kind + change.claim)}
									<li>{changeText(change)}</li>
								{/each}
							</ul>
						{/if}
					{:else}
						<ul class="changes muted">
							{#each app.held_back as held (`${held.claim}\u0000${held.scope}\u0000${held.reason ?? ''}`)}
								<li>{heldBackText(held)}</li>
							{/each}
						</ul>
					{/if}
				{/snippet}
			</DataTable>
		</Card>

		{#if preview.sample}
			<Card
				title={t('mc.ch.sampleTitle')}
				description={t('mc.ch.sampleDesc', { user: sampleLabel })}
				flush
			>
				<DataTable
					caption={t('mc.ch.sampleTitle')}
					columns={[
						{ key: 'claim', label: t('mc.ch.col.claim'), width: '24%' },
						{ key: 'before', label: t('mc.ch.col.before') },
						{ key: 'after', label: t('mc.ch.col.after') }
					]}
					rows={preview.sample.claims}
					rowKey={(row) => row.claim}
				>
					{#snippet cell(row, column)}
						{#if column.key === 'claim'}
							<code>{row.claim}</code>
						{:else}
							{@const value = column.key === 'before' ? row.before : row.after}
							{#if row.not_evaluated?.includes(column.key === 'before' ? 'before' : 'after')}
								<span class="muted">{t('map.sample.atSignIn')}</span>
							{:else if value === null}
								<span class="muted">{t('mc.ch.notSent')}</span>
							{:else}
								<code>{value}</code>
							{/if}
						{/if}
					{/snippet}
				</DataTable>
			</Card>
		{/if}
	{/if}
{/if}

<style>
	.head {
		display: grid;
		gap: var(--space-related);
		padding-bottom: var(--space-field);
	}

	.head__row {
		display: flex;
		align-items: center;
		gap: 4px;
		min-width: 0;
	}

	.head__row.is-hidden {
		display: none;
	}

	.head__title {
		margin: 0;
		font-size: var(--fs-title);
		font-weight: var(--fw-semibold);
		line-height: var(--lh-tight);
		overflow-wrap: anywhere;
	}

	.head__desc {
		margin: 0;
		color: var(--text-secondary);
		font-size: var(--fs-small);
	}

	.form {
		display: flex;
		flex-direction: column;
		gap: var(--space-field);
	}

	.form p {
		margin: 0;
	}

	.row {
		max-inline-size: 24rem;
	}

	.changes {
		margin: 0;
		padding-inline-start: 1.2em;
		display: flex;
		flex-direction: column;
		gap: 2px;
	}

	.muted {
		color: var(--text-secondary);
	}
</style>
