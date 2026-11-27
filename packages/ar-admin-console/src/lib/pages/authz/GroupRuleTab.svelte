<script lang="ts">
	import { untrack } from 'svelte';
	import type { AuthzAccess } from '#lib/access/access.js';
	import type {
		DynamicCatalog,
		DynamicGroupDefinition,
		EndUserGroupDetail,
		EndUserGroupsClient
	} from '#lib/api/end-user-groups.js';
	import { t } from '#lib/i18n/i18n.svelte.js';
	import Callout from '#lib/ui/patterns/Callout.svelte';
	import Card from '#lib/ui/patterns/Card.svelte';
	import ConditionBuilder from '#lib/ui/patterns/ConditionBuilder.svelte';
	import type { ConditionGroup } from '#lib/ui/patterns/condition-model.js';
	import DataTable from '#lib/ui/patterns/DataTable.svelte';
	import EmptyState from '#lib/ui/patterns/EmptyState.svelte';
	import LoadingState from '#lib/ui/patterns/LoadingState.svelte';
	import RowStack from '#lib/ui/patterns/RowStack.svelte';
	import TextAreaRow from '#lib/ui/patterns/TextAreaRow.svelte';
	import TextRow from '#lib/ui/patterns/TextRow.svelte';
	import Badge from '#lib/ui/primitives/Badge.svelte';
	import Button from '#lib/ui/primitives/Button.svelte';
	import Checkbox from '#lib/ui/primitives/Checkbox.svelte';
	import DateTime from '#lib/ui/time/DateTime.svelte';
	import { toast } from '#lib/ui/toast/toast.svelte.js';
	import { authzRefusal, refusalText } from './authz-errors';
	import {
		conditionFromExpression,
		conditionToSave,
		fieldsFromCatalog
	} from './dynamic-rule-model';

	/**
	 * A dynamic group's rule (the service-group catalog): who is in it, decided from their
	 * attributes, and whether the rule is on. Saving names the catalog revision read, so a change
	 * someone else saved first is not overwritten. Under it: how far each account shard's
	 * evaluation has got with the current revision.
	 *
	 * A field people write themselves cannot decide a group that carries roles (the API refuses
	 * the save); a rule the builder cannot draw (a reference to another group…) is shown as it is.
	 */
	interface Props {
		client: EndUserGroupsClient;
		group: EndUserGroupDetail;
		access: AuthzAccess;
		/**
		 * The rule was saved: the group is read again. `expiryPending`: not every shard was reached,
		 * so memberships under the old rule may still grant there until the scheduled scan stops
		 * them. The page keeps saying so even if reading the group again fails.
		 */
		onsaved: (result: { expiryPending: boolean }) => Promise<void>;
	}

	let { client, group, access, onsaved }: Props = $props();

	let catalog = $state<DynamicCatalog | null>(null);
	let definition = $state<DynamicGroupDefinition | null>(null);
	let phase = $state<'loading' | 'ready' | 'missing' | 'failed'>('loading');
	let condition = $state<ConditionGroup | null>(null);
	/** The admin changed the condition in the builder since it was read. */
	let conditionEdited = $state(false);
	let name = $state('');
	let description = $state('');
	let enabled = $state(true);
	let invalid = $state(false);
	let busy = $state(false);
	let refusal = $state('');

	async function load() {
		phase = 'loading';
		refusal = '';
		try {
			const read = await client.catalog();
			catalog = read;
			definition = read.groups.find((item) => item.id === group.id) ?? null;
			if (!definition) {
				phase = 'missing';
				return;
			}
			name = definition.displayName;
			description = definition.description;
			enabled = definition.enabled;
			condition = conditionFromExpression(definition.condition);
			conditionEdited = false;
			phase = 'ready';
		} catch {
			phase = 'failed';
		}
	}

	$effect(() => {
		void group.id;
		untrack(() => void load());
	});

	const fields = $derived(catalog ? fieldsFromCatalog(catalog.fields) : []);
	const selfWritable = $derived(
		catalog
			? Object.entries(catalog.fields)
					.filter(([, field]) => field.selfWritable)
					.map(([key]) => key)
			: []
	);
	const editable = $derived(access.rulesWrite);

	async function save() {
		if (!catalog || !definition) return;
		if (!name.trim()) {
			refusal = t('grp.new.nameRequired');
			return;
		}
		// An unedited condition is sent as it was read, whatever the builder thinks of it.
		if (invalid && conditionEdited) return;
		busy = true;
		refusal = '';
		try {
			// Plain copies of what was read (not the page's reactive state), sent as they are.
			const read = $state.snapshot(definition);
			const saved = await client.saveDynamic(
				{
					...read,
					displayName: name.trim(),
					description: description.trim(),
					enabled,
					condition: conditionToSave(
						read.condition,
						conditionEdited,
						$state.snapshot(condition),
						catalog.fields
					)
				},
				catalog.revision
			);
			toast.success(t('grp.rule.saved'));
			const expiryPending = saved.publication?.status === 'expiry_pending';
			await load();
			await onsaved({ expiryPending });
		} catch (failure) {
			refusal = refusalText(failure, t);
			// Someone saved the catalog first: show what it is now, so the change is made on that.
			if (authzRefusal(failure).key === 'grp.error.catalogChanged') {
				const kept = refusal;
				await load();
				refusal = kept;
			}
		} finally {
			busy = false;
		}
	}

	const scanColumns = $derived([
		{ key: 'shard', label: t('grp.rule.scans.col.shard') },
		{ key: 'status', label: t('grp.rule.scans.col.status'), width: '22%' },
		{
			key: 'processed',
			label: t('grp.rule.scans.col.processed'),
			width: '16%',
			align: 'end' as const
		},
		{
			key: 'failures',
			label: t('grp.rule.scans.col.failures'),
			width: '14%',
			align: 'end' as const
		},
		{ key: 'updated', label: t('grp.rule.scans.col.updated'), width: '22%' }
	]);
	const STATUS_TONE = {
		completed: 'success',
		processing: 'info',
		pending: 'neutral',
		failed: 'danger'
	} as const;
	const statusKey = (status: string) =>
		status === 'completed'
			? 'grp.rule.scan.completed'
			: status === 'processing'
				? 'grp.rule.scan.processing'
				: status === 'failed'
					? 'grp.rule.scan.failed'
					: 'grp.rule.scan.pending';
</script>

{#if phase === 'loading'}
	<LoadingState label={t('common.loading')} />
{:else if phase === 'failed'}
	<EmptyState icon="warningCircle" title={t('grp.rule.loadFailed')}>
		{#snippet action()}
			<Button size="sm" onclick={load}>{t('common.retry')}</Button>
		{/snippet}
	</EmptyState>
{:else if phase === 'missing' || !catalog || !definition}
	<EmptyState icon="warning" title={t('grp.rule.missing')} />
{:else}
	<Card title={t('grp.rule.title')} description={t('grp.rule.desc')}>
		<RowStack>
			<TextRow
				label={t('grp.new.name')}
				required
				maxlength={200}
				readonly={!editable}
				bind:value={name}
			/>
			<TextAreaRow
				label={t('grp.new.description')}
				maxlength={2000}
				readonly={!editable}
				bind:value={description}
			/>
			<Checkbox
				checked={enabled}
				disabled={!editable}
				description={t('grp.rule.enabledDesc')}
				onchange={(event) => (enabled = event.currentTarget.checked)}
			>
				{t('grp.rule.enabled')}
			</Checkbox>
			{#if condition}
				{#if editable}
					<ConditionBuilder
						label={t('grp.rule.condition')}
						bind:value={
							() => condition!,
							(next) => {
								condition = next;
								conditionEdited = true;
							}
						}
						{fields}
						bind:invalid
						emptyText={t('grp.rule.noCondition')}
					/>
				{:else}
					<p class="muted">{t('grp.rule.readOnly')}</p>
					<pre class="expression">{JSON.stringify(definition.condition, null, 2)}</pre>
				{/if}
			{:else}
				<Callout icon="info">{t('grp.rule.notDrawable')}</Callout>
				<pre class="expression">{JSON.stringify(definition.condition, null, 2)}</pre>
			{/if}
			{#if selfWritable.length > 0}
				<p class="muted">{t('grp.rule.selfWritable', { fields: selfWritable.join(', ') })}</p>
			{/if}
		</RowStack>
		{#if refusal}
			<Callout tone="danger" live>{refusal}</Callout>
		{/if}
		{#if editable}
			<div class="actions">
				<Button variant="primary" loading={busy} onclick={save}>{t('grp.rule.save')}</Button>
			</div>
		{/if}
	</Card>

	<Card
		title={t('grp.rule.scans')}
		description={t('grp.rule.scansDesc', { revision: catalog.revision })}
		flush
	>
		<DataTable
			caption={t('grp.rule.scans')}
			columns={scanColumns}
			rows={catalog.scans}
			rowKey={(row) => row.binding_ref}
		>
			{#snippet cell(row, column)}
				{#if column.key === 'shard'}
					<code>{row.binding_ref}</code>
					{#if row.rule_version < catalog!.revision}
						<Badge tone="warning">{t('grp.rule.scan.behind', { version: row.rule_version })}</Badge>
					{/if}
				{:else if column.key === 'status'}
					<Badge tone={STATUS_TONE[row.status as keyof typeof STATUS_TONE] ?? 'neutral'} dot>
						{t(statusKey(row.status))}
					</Badge>
				{:else if column.key === 'processed'}
					{row.processed}
				{:else if column.key === 'failures'}
					{row.failures}
				{:else if row.updated_at}
					<DateTime value={row.updated_at} stacked />
				{/if}
			{/snippet}
			{#snippet empty()}
				<EmptyState icon="activity" title={t('grp.rule.scans.empty')} />
			{/snippet}
		</DataTable>
	</Card>
{/if}

<style>
	.muted {
		margin: 0;
		color: var(--text-muted);
	}

	.expression {
		margin: 0;
		padding: var(--space-related);
		overflow-x: auto;
		border: 1px solid var(--border-subtle);
		border-radius: var(--radius-sm);
		font-family: var(--font-mono);
		font-size: var(--fs-caption);
		white-space: pre-wrap;
	}

	.actions {
		display: flex;
		gap: var(--space-related);
		margin-top: var(--space-related);
	}
</style>
