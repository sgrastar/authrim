<script lang="ts">
	import { untrack } from 'svelte';
	import type { AuthzAccess } from '#lib/access/access.js';
	import { ApiError } from '#lib/api/api-error.js';
	import type {
		DefinitionInput,
		EndUserRebacClient,
		RelationDefinition
	} from '#lib/api/end-user-rebac.js';
	import { t } from '#lib/i18n/i18n.svelte.js';
	import BusyScope from '#lib/ui/busy/BusyScope.svelte';
	import Callout from '#lib/ui/patterns/Callout.svelte';
	import Card from '#lib/ui/patterns/Card.svelte';
	import DangerZone from '#lib/ui/patterns/DangerZone.svelte';
	import EmptyState from '#lib/ui/patterns/EmptyState.svelte';
	import FieldRow from '#lib/ui/patterns/FieldRow.svelte';
	import JsonField from '#lib/ui/patterns/JsonField.svelte';
	import LoadingState from '#lib/ui/patterns/LoadingState.svelte';
	import PageHeader from '#lib/ui/patterns/PageHeader.svelte';
	import RowStack from '#lib/ui/patterns/RowStack.svelte';
	import TextAreaRow from '#lib/ui/patterns/TextAreaRow.svelte';
	import TextRow from '#lib/ui/patterns/TextRow.svelte';
	import ToggleRow from '#lib/ui/patterns/ToggleRow.svelte';
	import BackLink from '#lib/ui/primitives/BackLink.svelte';
	import Badge from '#lib/ui/primitives/Badge.svelte';
	import Button from '#lib/ui/primitives/Button.svelte';
	import NumberField from '#lib/ui/primitives/NumberField.svelte';
	import Page from '#lib/ui/templates/Page.svelte';
	import { toast } from '#lib/ui/toast/toast.svelte.js';
	import ObjectTypeField from './ObjectTypeField.svelte';
	import RelationExpressionEditor from './RelationExpressionEditor.svelte';
	import {
		definitionChanges,
		definitionDraftOf,
		definitionInputOf,
		definitionResult,
		emptyDefinitionDraft,
		jsonIsDrawable,
		rebacRefusalText,
		relationNamesOf,
		toJsonMode,
		toTreeMode,
		type DefinitionDraft
	} from './rebac-model';

	/**
	 * Access → Relationships → one definition (`new` for a new one): the object type and relation
	 * it defines (fixed once saved), how the relation is computed, a priority and whether it is
	 * active. The expression is built from parts (a relation on the same object, any or all of
	 * several, one without another, or a relation on the object another relation leads to); a shape
	 * the builder cannot draw is edited as JSON. A definition the API could not read is shown as
	 * such: replacing its expression repairs it. Without `admin:roles:write` it is shown as it is.
	 */
	interface Props {
		client: EndUserRebacClient;
		/** A definition's id, or `new`. */
		definitionId: string;
		access: AuthzAccess;
		listHref: string;
		oncreated: (definitionId: string) => void;
		ondeleted: () => void;
	}

	let { client, definitionId, access, listHref, oncreated, ondeleted }: Props = $props();

	const creating = $derived(definitionId === 'new');

	let found = $state<RelationDefinition | null>(null);
	let siblings = $state<RelationDefinition[]>([]);
	let objectTypes = $state<string[]>([]);
	let phase = $state<'loading' | 'ready' | 'notFound' | 'forbidden' | 'failed'>('loading');
	let draft = $state<DefinitionDraft>(emptyDefinitionDraft());
	let saved = $state<DefinitionInput | null>(null);
	let busy = $state(false);
	let tried = $state(false);
	let refusal = $state('');
	let notDrawable = $state(false);

	async function load() {
		phase = 'loading';
		try {
			const [types, loaded, all] = await Promise.all([
				client.objectTypes().catch(() => []),
				creating ? Promise.resolve(null) : client.getDefinition(definitionId),
				client
					.listDefinitions({ limit: 200 })
					.then((result) => result.items)
					.catch(() => [])
			]);
			objectTypes = types.map((entry) => entry.name);
			siblings = all;
			found = loaded;
			draft = loaded ? definitionDraftOf(loaded) : emptyDefinitionDraft();
			saved = loaded ? definitionInputOf(loaded) : null;
			notDrawable = false;
			phase = 'ready';
		} catch (failure) {
			found = null;
			phase =
				failure instanceof ApiError && failure.status === 404
					? 'notFound'
					: failure instanceof ApiError && failure.status === 403
						? 'forbidden'
						: 'failed';
		}
	}

	$effect(() => {
		void definitionId;
		untrack(() => void load());
	});

	const editable = $derived(access.rebacWrite);
	const result = $derived(definitionResult(draft, creating));
	const problems = $derived(tried ? result.problems : { expression: {} });
	const suggestions = $derived(relationNamesOf(siblings, draft.object_type));
	const drawable = $derived(jsonIsDrawable(draft.json));

	async function save() {
		tried = true;
		refusal = '';
		const input = result.input;
		if (!input) return;
		busy = true;
		try {
			if (creating) {
				const created = await client.createDefinition(input);
				toast.success(
					t('rb.def.toast.created', { name: `${input.object_type}#${input.relation_name}` })
				);
				oncreated(created.id);
				return;
			}
			if (!found || !saved) return;
			const changes = definitionChanges(saved, input);
			if (Object.keys(changes).length === 0) {
				toast.info(t('rb.def.noChanges'));
				return;
			}
			await client.updateDefinition(found.id, changes);
			toast.success(t('rb.def.saved'));
			tried = false;
			await load();
		} catch (failure) {
			refusal = rebacRefusalText(failure, 'definition', t);
		} finally {
			busy = false;
		}
	}

	async function remove() {
		if (!found) return;
		const name = `${found.object_type}#${found.relation_name}`;
		try {
			await client.removeDefinition(found.id);
		} catch (failure) {
			toast.error(rebacRefusalText(failure, 'definition', t));
			return;
		}
		toast.success(t('rb.def.toast.deleted', { name }));
		ondeleted();
	}

	const title = $derived(
		creating
			? t('rb.def.new.title')
			: found
				? `${found.object_type}#${found.relation_name}`
				: t('nav.access.relationships')
	);
</script>

<Page>
	<PageHeader {title}>
		{#snippet back()}
			<BackLink href={listHref}>{t('rb.def.back')}</BackLink>
		{/snippet}
		{#snippet badges()}
			{#if found}
				{#if found.unusable}<Badge tone="danger">{t('rb.def.unusable')}</Badge>{/if}
				{#if !found.active}<Badge>{t('rb.def.state.off')}</Badge>{/if}
			{/if}
		{/snippet}
	</PageHeader>

	{#if phase === 'loading'}
		<LoadingState label={t('common.loading')} />
	{:else if phase === 'notFound'}
		<EmptyState icon="shield" title={t('rb.def.notFound')} />
	{:else if phase === 'forbidden' || (creating && !editable)}
		<EmptyState icon="lock" title={t('rb.noAccess')} />
	{:else if phase === 'failed'}
		<EmptyState icon="warningCircle" title={t('rb.def.loadFailedOne')}>
			{#snippet action()}
				<Button size="sm" onclick={load}>{t('common.retry')}</Button>
			{/snippet}
		</EmptyState>
	{:else}
		{#if !editable}
			<Callout icon="lock">{t('rb.def.readOnly')}</Callout>
		{/if}
		{#if found?.unusable}
			<Callout tone="danger">{t('rb.def.unusableBody')}</Callout>
		{/if}

		<BusyScope busy={busy || !editable}>
			<Card title={t('rb.def.profile')}>
				<RowStack>
					{#if creating}
						<FieldRow label={t('rb.def.objectType')} required plain>
							<ObjectTypeField
								label={t('rb.def.objectType')}
								types={objectTypes}
								required
								hint={t('rb.def.objectTypeHint')}
								error={problems.object_type ? t(problems.object_type) : undefined}
								bind:value={draft.object_type}
							/>
						</FieldRow>
						<TextRow
							label={t('rb.def.relationName')}
							required
							hint={t('rb.def.relationNameHint')}
							placeholder="viewer"
							error={problems.relation_name ? t(problems.relation_name) : undefined}
							bind:value={draft.relation_name}
						/>
					{/if}
					<TextAreaRow
						label={t('rb.def.description')}
						maxlength={500}
						bind:value={draft.description}
					/>
					<FieldRow label={t('rb.def.priority')} info={t('rb.def.priorityInfo')} required plain>
						<NumberField
							label={t('rb.def.priority')}
							hideLabel
							required
							error={problems.priority ? t(problems.priority) : undefined}
							bind:value={draft.priority}
						/>
					</FieldRow>
					<ToggleRow
						label={t('rb.def.active')}
						description={t('rb.def.activeDesc')}
						bind:checked={draft.active}
					/>
				</RowStack>
			</Card>

			<Card title={t('rb.def.expression')} description={t('rb.def.expressionHint')}>
				<div class="expression">
					{#if draft.jsonMode}
						<p class="muted">{t('rb.def.jsonMode')}</p>
						<JsonField label={t('rb.def.jsonLabel')} rows={12} bind:value={draft.json} />
						{#if problems.json}<p class="problem" role="alert">{t(problems.json)}</p>{/if}
						{#if notDrawable}<p class="problem" role="alert">{t('rb.def.cannotDraw')}</p>{/if}
						{#if editable}
							<div>
								<Button
									size="sm"
									variant="ghost"
									disabled={!drawable}
									onclick={() => (notDrawable = !toTreeMode(draft))}
								>
									{t('rb.def.asBuilder')}
								</Button>
							</div>
						{/if}
					{:else}
						<RelationExpressionEditor
							bind:draft={draft.expression}
							problems={problems.expression}
							{suggestions}
							disabled={!editable}
						/>
						{#if editable}
							<div>
								<Button size="sm" variant="ghost" icon="braces" onclick={() => toJsonMode(draft)}>
									{t('rb.def.asJson')}
								</Button>
							</div>
						{/if}
					{/if}
				</div>
			</Card>
		</BusyScope>

		{#if refusal}
			<Callout tone="danger" live>{refusal}</Callout>
		{/if}
		{#if editable}
			<div class="actions">
				<Button variant="primary" loading={busy} onclick={save}>
					{creating ? t('rb.def.new.submit') : t('rb.def.save')}
				</Button>
			</div>
		{/if}

		{#if found && access.rebacDelete}
			<DangerZone
				title={t('rb.def.delete.title')}
				description={t('rb.def.delete.desc')}
				actionLabel={t('rb.def.delete.action')}
				confirmTitle={t('rb.def.delete.confirmTitle', {
					name: `${found.object_type}#${found.relation_name}`
				})}
				confirmBody={t('rb.def.delete.confirmBody')}
				onconfirm={remove}
			/>
		{/if}
	{/if}
</Page>

<style>
	.actions {
		display: flex;
		gap: var(--space-related);
	}

	.expression {
		display: grid;
		gap: var(--space-related);
	}

	.muted {
		margin: 0;
		color: var(--text-muted);
	}

	.problem {
		margin: 0;
		color: var(--danger);
		font-size: var(--fs-small);
	}
</style>
