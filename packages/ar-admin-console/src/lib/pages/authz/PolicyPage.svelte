<script lang="ts">
	import { untrack } from 'svelte';
	import type { AuthzAccess } from '#lib/access/access.js';
	import { ApiError } from '#lib/api/api-error.js';
	import type { EndUserGroupsClient } from '#lib/api/end-user-groups.js';
	import type {
		ConditionTypeInfo,
		ConditionTypes,
		EndUserPoliciesClient,
		PolicyEffect,
		PolicyInput,
		PolicyRule
	} from '#lib/api/end-user-policies.js';
	import { t } from '#lib/i18n/i18n.svelte.js';
	import BusyScope from '#lib/ui/busy/BusyScope.svelte';
	import Callout from '#lib/ui/patterns/Callout.svelte';
	import Card from '#lib/ui/patterns/Card.svelte';
	import DangerZone from '#lib/ui/patterns/DangerZone.svelte';
	import EmptyState from '#lib/ui/patterns/EmptyState.svelte';
	import FieldRow from '#lib/ui/patterns/FieldRow.svelte';
	import ListField from '#lib/ui/patterns/ListField.svelte';
	import LoadingState from '#lib/ui/patterns/LoadingState.svelte';
	import PageHeader from '#lib/ui/patterns/PageHeader.svelte';
	import RowStack from '#lib/ui/patterns/RowStack.svelte';
	import SelectRow from '#lib/ui/patterns/SelectRow.svelte';
	import TextAreaRow from '#lib/ui/patterns/TextAreaRow.svelte';
	import TextRow from '#lib/ui/patterns/TextRow.svelte';
	import ToggleRow from '#lib/ui/patterns/ToggleRow.svelte';
	import BackLink from '#lib/ui/primitives/BackLink.svelte';
	import Badge from '#lib/ui/primitives/Badge.svelte';
	import Button from '#lib/ui/primitives/Button.svelte';
	import NumberField from '#lib/ui/primitives/NumberField.svelte';
	import Select from '#lib/ui/primitives/Select.svelte';
	import Page from '#lib/ui/templates/Page.svelte';
	import { toast } from '#lib/ui/toast/toast.svelte.js';
	import { refusalText } from './authz-errors';
	import PolicyConditionEditor from './PolicyConditionEditor.svelte';
	import {
		draftOf,
		emptyDraft,
		groupIdsOf,
		inputOf,
		newConditionDraft,
		policyChanges,
		policyResult,
		type PolicyDraft,
		type PolicyProblems
	} from './policy-model';
	import { groupSearch } from './user-picker';

	/**
	 * Access → Policies → one rule (`new` for a new one): its effect, priority, the resource types
	 * and actions it covers, and the conditions that must all hold. The conditions on offer are the
	 * ones the API can evaluate, so the editor follows the engine. Without `admin:roles:write` the
	 * rule is shown as it is. Rules are additive: a deny does not take back a permission a role
	 * already gave.
	 */
	interface Props {
		client: EndUserPoliciesClient;
		groups: Pick<EndUserGroupsClient, 'list' | 'get'>;
		/** A rule's id, or `new`. */
		ruleId: string;
		access: AuthzAccess;
		listHref: string;
		oncreated: (ruleId: string) => void;
		ondeleted: () => void;
	}

	let { client, groups, ruleId, access, listHref, oncreated, ondeleted }: Props = $props();

	const creating = $derived(ruleId === 'new');

	let rule = $state<PolicyRule | null>(null);
	let types = $state<ConditionTypes>({ types: [], categories: [] });
	let phase = $state<'loading' | 'ready' | 'notFound' | 'forbidden' | 'failed'>('loading');
	let draft = $state<PolicyDraft>(emptyDraft());
	let saved = $state<PolicyInput | null>(null);
	let busy = $state(false);
	let tried = $state(false);
	let refusal = $state('');
	let nextKey = 1;
	let adding = $state('');

	const searchGroups = $derived(
		groupSearch(groups, {
			typedAsId: t('az.picker.groupTypedId'),
			searchRefused: t('az.picker.groupSearchRefused')
		})
	);

	/** The names of the groups a rule's conditions use (an id stays an id when unreadable). */
	async function groupLabels(found: PolicyRule, known: ConditionTypeInfo[]) {
		const names: Record<string, string> = {};
		await Promise.all(
			groupIdsOf(found, known).map(async (id) => {
				try {
					names[id] = (await groups.get(id)).display_name;
				} catch {
					// The id is shown instead.
				}
			})
		);
		return (id: string) => names[id] ?? id;
	}

	async function load() {
		phase = 'loading';
		try {
			const [catalog, found] = await Promise.all([
				client.conditionTypes(),
				creating ? Promise.resolve(null) : client.get(ruleId)
			]);
			types = catalog;
			rule = found;
			if (found) {
				const label = await groupLabels(found, catalog.types);
				draft = draftOf(found, catalog.types, label);
				nextKey = found.conditions.length + 1;
				saved = inputOf(found);
			} else {
				draft = emptyDraft();
				nextKey = 1;
				saved = null;
			}
			phase = 'ready';
		} catch (failure) {
			rule = null;
			phase =
				failure instanceof ApiError && failure.status === 404
					? 'notFound'
					: failure instanceof ApiError && failure.status === 403
						? 'forbidden'
						: 'failed';
		}
	}

	$effect(() => {
		void ruleId;
		untrack(() => void load());
	});

	const editable = $derived(access.rolesWrite);
	const result = $derived(policyResult(draft, types.types, saved));
	const problems = $derived<PolicyProblems>(tried ? result.problems : { conditions: {} });
	const typeOptions = $derived(
		types.types.map((info) => {
			const category = types.categories.find((entry) => entry.id === info.category);
			return {
				value: info.type,
				label: category ? `${category.label}: ${info.label}` : info.label
			};
		})
	);
	const effectOptions = $derived([
		{ value: 'allow', label: t('pol.effect.allow'), description: t('pol.effect.allowDesc') },
		{ value: 'deny', label: t('pol.effect.deny'), description: t('pol.effect.denyDesc') }
	]);

	function addCondition(type: string) {
		const info = types.types.find((entry) => entry.type === type);
		if (info) draft.conditions.push(newConditionDraft(nextKey++, info));
		adding = '';
	}

	async function save() {
		tried = true;
		refusal = '';
		const input = result.input;
		if (!input) return;
		busy = true;
		try {
			if (creating) {
				const created = await client.create(input);
				toast.success(t('pol.toast.created', { name: input.name }));
				oncreated(created.id);
				return;
			}
			if (!rule || !saved) return;
			const changes = policyChanges(saved, input);
			if (Object.keys(changes).length === 0) {
				toast.info(t('pol.edit.noChanges'));
				return;
			}
			await client.update(rule.id, changes);
			toast.success(t('pol.edit.saved'));
			tried = false;
			await load();
		} catch (failure) {
			refusal = refusalText(failure, t);
		} finally {
			busy = false;
		}
	}

	async function remove() {
		if (!rule) return;
		const name = rule.name;
		try {
			await client.remove(rule.id);
		} catch (failure) {
			toast.error(refusalText(failure, t));
			return;
		}
		toast.success(t('pol.toast.deleted', { name }));
		ondeleted();
	}

	const title = $derived(
		creating ? t('pol.new.title') : rule ? rule.name : t('nav.access.policies')
	);
</script>

<Page>
	<PageHeader {title}>
		{#snippet back()}
			<BackLink href={listHref}>{t('pol.edit.back')}</BackLink>
		{/snippet}
		{#snippet badges()}
			{#if rule}
				<Badge tone={rule.effect === 'deny' ? 'danger' : 'success'}>
					{t(rule.effect === 'deny' ? 'pol.effect.deny' : 'pol.effect.allow')}
				</Badge>
				{#if !rule.enabled}<Badge>{t('pol.state.off')}</Badge>{/if}
			{/if}
		{/snippet}
	</PageHeader>

	{#if phase === 'loading'}
		<LoadingState label={t('common.loading')} />
	{:else if phase === 'notFound'}
		<EmptyState icon="shield" title={t('pol.edit.notFound')} />
	{:else if phase === 'forbidden' || (creating && !editable)}
		<EmptyState icon="lock" title={t('pol.list.noAccess')} />
	{:else if phase === 'failed'}
		<EmptyState icon="warningCircle" title={t('pol.edit.loadFailed')}>
			{#snippet action()}
				<Button size="sm" onclick={load}>{t('common.retry')}</Button>
			{/snippet}
		</EmptyState>
	{:else}
		{#if !editable}
			<Callout icon="lock">{t('pol.edit.readOnly')}</Callout>
		{/if}
		<Callout icon="info">{t('pol.additive')}</Callout>

		<BusyScope busy={busy || !editable}>
			<Card title={t('pol.edit.profile')}>
				<RowStack>
					<TextRow
						label={t('pol.edit.name')}
						required
						maxlength={255}
						error={problems.name ? t(problems.name) : undefined}
						bind:value={draft.name}
					/>
					<TextAreaRow
						label={t('pol.edit.description')}
						maxlength={500}
						bind:value={draft.description}
					/>
					<SelectRow
						label={t('pol.edit.effect')}
						info={t('pol.edit.effectInfo')}
						options={effectOptions}
						bind:value={() => draft.effect, (value) => (draft.effect = value as PolicyEffect)}
					/>
					<FieldRow label={t('pol.edit.priority')} info={t('pol.edit.priorityInfo')} required plain>
						<NumberField
							label={t('pol.edit.priority')}
							hideLabel
							required
							error={problems.priority ? t(problems.priority) : undefined}
							bind:value={draft.priority}
						/>
					</FieldRow>
					<ToggleRow
						label={t('pol.edit.enabled')}
						description={t('pol.edit.enabledDesc')}
						bind:checked={draft.enabled}
					/>
				</RowStack>
			</Card>

			<Card title={t('pol.edit.scope')} description={t('pol.edit.scopeHint')}>
				<RowStack>
					<FieldRow label={t('pol.edit.resourceTypes')} plain>
						<ListField
							label={t('pol.edit.resourceTypes')}
							placeholder="document"
							mono
							raw
							addLabel={t('pol.edit.addResourceType')}
							bind:values={draft.resource_types}
						/>
					</FieldRow>
					<FieldRow label={t('pol.edit.actions')} plain>
						<ListField
							label={t('pol.edit.actions')}
							placeholder="read"
							mono
							raw
							addLabel={t('pol.edit.addAction')}
							bind:values={draft.actions}
						/>
					</FieldRow>
				</RowStack>
			</Card>

			<Card title={t('pol.edit.conditions')} description={t('pol.edit.conditionsHint')}>
				<div class="conditions">
					<p class="muted">{t('pol.edit.dynamicHint')}</p>
					{#each draft.conditions as condition, index (condition.key)}
						<PolicyConditionEditor
							bind:draft={draft.conditions[index]}
							info={types.types.find((entry) => entry.type === condition.type)}
							problems={problems.conditions[condition.key]}
							{searchGroups}
							onremove={() => draft.conditions.splice(index, 1)}
						/>
					{:else}
						<p class="muted">{t('pol.edit.noConditions')}</p>
					{/each}
					<Select
						label={t('pol.edit.addCondition')}
						placeholder={t('pol.edit.addConditionPlaceholder')}
						options={typeOptions}
						bind:value={() => adding, (value) => value && addCondition(value)}
					/>
				</div>
			</Card>
		</BusyScope>

		{#if refusal}
			<Callout tone="danger" live>{refusal}</Callout>
		{/if}
		{#if editable}
			<div class="actions">
				<Button variant="primary" loading={busy} onclick={save}>
					{creating ? t('pol.new.submit') : t('pol.edit.save')}
				</Button>
			</div>
		{/if}

		{#if rule && editable}
			<DangerZone
				title={t('pol.delete.title')}
				description={t('pol.delete.desc')}
				actionLabel={t('pol.delete.action')}
				confirmTitle={t('pol.delete.confirmTitle', { name: rule.name })}
				confirmBody={t('pol.delete.confirmBody')}
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

	.conditions {
		display: grid;
		gap: var(--space-related);
	}

	.muted {
		margin: 0;
		color: var(--text-muted);
	}
</style>
