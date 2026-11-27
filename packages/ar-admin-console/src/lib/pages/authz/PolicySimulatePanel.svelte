<script lang="ts">
	import type { AuthzAccess } from '#lib/access/access.js';
	import type { AdminUsersClient } from '#lib/api/admin-users.js';
	import type { EndUserGroupsClient } from '#lib/api/end-user-groups.js';
	import type { EndUserPoliciesClient, PolicySimulation } from '#lib/api/end-user-policies.js';
	import { hasMessage, t, type MessageKey } from '#lib/i18n/i18n.svelte.js';
	import Callout from '#lib/ui/patterns/Callout.svelte';
	import Card from '#lib/ui/patterns/Card.svelte';
	import DetailItem from '#lib/ui/patterns/DetailItem.svelte';
	import DetailList from '#lib/ui/patterns/DetailList.svelte';
	import EntityPicker, { type PickerItem } from '#lib/ui/patterns/EntityPicker.svelte';
	import FieldRow from '#lib/ui/patterns/FieldRow.svelte';
	import KeyValueField, { type KeyValue } from '#lib/ui/patterns/KeyValueField.svelte';
	import ListField from '#lib/ui/patterns/ListField.svelte';
	import RowStack from '#lib/ui/patterns/RowStack.svelte';
	import TextRow from '#lib/ui/patterns/TextRow.svelte';
	import Button from '#lib/ui/primitives/Button.svelte';
	import RadioGroup from '#lib/ui/primitives/RadioGroup.svelte';
	import Icon from '#lib/ui/icons/Icon.svelte';
	import { refusalText } from './authz-errors';
	import {
		EMPTY_SIMULATION,
		simulationInput,
		simulationProblems,
		type SimulationForm
	} from './policy-model';
	import { groupSearch, userSearch } from './user-picker';

	/**
	 * Try the tenant's rules on one question: whether the rules (and only the rules) would allow
	 * a user to do something to a resource, and which rule decided. The user's groups are the
	 * server's to find unless some are given here. Nothing is saved.
	 */
	interface Props {
		client: Pick<EndUserPoliciesClient, 'simulate'>;
		users: Pick<AdminUsersClient, 'list'>;
		groups: Pick<EndUserGroupsClient, 'list'>;
		access: AuthzAccess;
	}

	let { client, users, groups, access }: Props = $props();

	let form = $state<SimulationForm>({ ...EMPTY_SIMULATION });
	let subject = $state<PickerItem[]>([]);
	let subjectGroups = $state<PickerItem[]>([]);
	let resourceGroups = $state<PickerItem[]>([]);
	let roleNames = $state<string[]>([]);
	let attributes = $state<KeyValue[]>([]);
	/** Whether the user's groups are the server's to find, or the ones listed here (maybe none). */
	let groupsMode = $state<'resolve' | 'given'>('resolve');
	let tried = $state(false);
	let busy = $state(false);
	let answer = $state<{ asked: string; result: PolicySimulation } | null>(null);
	let refusal = $state('');

	const searchUsers = $derived(
		userSearch(users, {
			typedAsId: t('az.picker.typedId'),
			searchRefused: t('az.picker.searchRefused'),
			canSearch: access.usersRead
		})
	);
	const searchGroups = $derived(
		groupSearch(groups, {
			typedAsId: t('az.picker.groupTypedId'),
			searchRefused: t('az.picker.groupSearchRefused')
		})
	);
	const problems = $derived(simulationProblems(form, subject[0]?.value ?? ''));

	let generation = 0;
	async function run() {
		tried = true;
		refusal = '';
		if (Object.keys(problems).length > 0) return;
		const input = simulationInput(
			form,
			subject[0]?.value ?? '',
			groupsMode === 'given' ? subjectGroups.map((item) => item.value) : null,
			roleNames,
			resourceGroups.map((item) => item.value),
			attributes
		);
		// Frozen now: what was asked stays with its answer while the form is edited.
		const asked = t('pol.sim.asked', {
			subject: subject[0]?.label ?? input.subject_id,
			action: `${input.resource_type}:${input.action}`
		});
		const mine = ++generation;
		busy = true;
		try {
			const result = await client.simulate(input);
			if (mine !== generation) return;
			answer = { asked, result };
		} catch (failure) {
			if (mine !== generation) return;
			answer = null;
			refusal = refusalText(failure, t);
		} finally {
			if (mine === generation) busy = false;
		}
	}

	/** One detail value as text: a list as its entries, anything else as JSON. */
	const shown = (value: unknown): string =>
		Array.isArray(value) && value.every((item) => typeof item === 'string')
			? value.join(', ') || '—'
			: typeof value === 'string'
				? value
				: JSON.stringify(value);
</script>

<Card title={t('pol.sim.title')} description={t('pol.sim.desc')}>
	<form
		class="form"
		novalidate
		onsubmit={(event) => {
			event.preventDefault();
			void run();
		}}
	>
		<RowStack>
			<FieldRow label={t('pol.sim.subject')} required>
				<EntityPicker
					label={t('pol.sim.subject')}
					placeholder={t('az.picker.placeholder')}
					multiple={false}
					search={searchUsers}
					error={tried && problems.subject ? t(problems.subject) : undefined}
					bind:items={subject}
				/>
			</FieldRow>
			<FieldRow label={t('pol.sim.groupsMode')} info={t('pol.sim.subjectGroupsHint')} plain>
				<RadioGroup
					label={t('pol.sim.groupsMode')}
					hideLabel
					options={[
						{ value: 'resolve', label: t('pol.sim.groupsResolve') },
						{ value: 'given', label: t('pol.sim.groupsGiven') }
					]}
					bind:value={() => groupsMode, (value) => (groupsMode = value as typeof groupsMode)}
				/>
			</FieldRow>
			{#if groupsMode === 'given'}
				<FieldRow label={t('pol.sim.subjectGroups')} info={t('pol.sim.groupsGivenHint')}>
					<EntityPicker
						label={t('pol.sim.subjectGroups')}
						placeholder={t('az.picker.groupPlaceholder')}
						search={searchGroups}
						bind:items={subjectGroups}
					/>
				</FieldRow>
			{/if}
			<FieldRow label={t('pol.sim.attributes')} info={t('pol.sim.attributesHint')} plain>
				<KeyValueField
					label={t('pol.sim.attributes')}
					keyLabel={t('pol.sim.attributeName')}
					valueLabel={t('pol.sim.attributeValue')}
					addLabel={t('pol.sim.addAttribute')}
					bind:entries={attributes}
				/>
			</FieldRow>
			<FieldRow label={t('pol.sim.roles')} info={t('pol.sim.rolesHint')} plain>
				<ListField
					label={t('pol.sim.roles')}
					placeholder="editor"
					mono
					addLabel={t('pol.sim.addRole')}
					bind:values={roleNames}
				/>
			</FieldRow>
			<TextRow
				label={t('pol.sim.resourceType')}
				required
				placeholder="document"
				error={tried && problems.resourceType ? t(problems.resourceType) : undefined}
				bind:value={form.resource_type}
			/>
			<TextRow
				label={t('pol.sim.resourceId')}
				placeholder="doc_789"
				bind:value={form.resource_id}
			/>
			<TextRow
				label={t('pol.sim.ownerId')}
				hint={t('pol.sim.ownerIdHint')}
				placeholder="usr_123"
				bind:value={form.owner_id}
			/>
			<FieldRow label={t('pol.sim.resourceGroups')} info={t('pol.sim.resourceGroupsHint')}>
				<EntityPicker
					label={t('pol.sim.resourceGroups')}
					placeholder={t('az.picker.groupPlaceholder')}
					search={searchGroups}
					bind:items={resourceGroups}
				/>
			</FieldRow>
			<TextRow
				label={t('pol.sim.action')}
				required
				placeholder="read"
				error={tried && problems.action ? t(problems.action) : undefined}
				bind:value={form.action}
			/>
			<TextRow
				label={t('pol.sim.timestamp')}
				placeholder="2026-11-28T09:30"
				hint={t('pol.sim.timestampHint')}
				error={tried && problems.timestamp ? t(problems.timestamp) : undefined}
				bind:value={form.timestamp}
			/>
		</RowStack>
		<div class="actions">
			<Button variant="primary" type="submit" icon="search" loading={busy}>
				{t('pol.sim.run')}
			</Button>
		</div>
	</form>
</Card>

{#if refusal}
	<Callout tone="danger" live>{refusal}</Callout>
{/if}

{#if answer}
	{@const { asked, result } = answer}
	<Card title={t('pol.sim.result')} tone={result.allowed ? 'default' : 'warning'}>
		<div class="verdict" aria-live="polite">
			<Icon name={result.allowed ? 'checkCircle' : 'warningCircle'} />
			<strong>{result.allowed ? t('pol.sim.allowed') : t('pol.sim.denied')}</strong>
			<span class="muted">{asked}</span>
		</div>
		<DetailList columns={2} ruled>
			<DetailItem label={t('pol.sim.reason')}>{result.reason || '—'}</DetailItem>
			<DetailItem label={t('pol.sim.decidedBy')}>
				{#if result.decided_by}<code>{result.decided_by}</code>{:else}—{/if}
			</DetailItem>
			{#if result.evaluated_rules !== null}
				<DetailItem label={t('pol.sim.evaluated')}>{result.evaluated_rules}</DetailItem>
			{/if}
		</DetailList>
		{#if result.details}
			<h3 class="details-title">{t('pol.sim.details')}</h3>
			<DetailList columns={2} ruled>
				{#each Object.entries(result.details) as [key, value] (key)}
					<DetailItem label={key}>
						{#if key === 'subject_groups' && typeof value === 'string' && hasMessage(`pol.sim.groups.${value}`)}
							{t(`pol.sim.groups.${value}` as MessageKey)}
						{/if}
						<code>{shown(value)}</code>
					</DetailItem>
				{/each}
			</DetailList>
		{/if}
	</Card>
{/if}

<style>
	.form {
		display: grid;
		gap: var(--space-related);
	}

	.actions {
		display: flex;
		gap: var(--space-related);
	}

	.verdict {
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		gap: var(--space-related);
		margin-bottom: var(--space-related);
		font-size: var(--fs-body-lg);
	}

	.muted {
		margin: 0;
		color: var(--text-muted);
		font-size: var(--fs-body);
	}

	.details-title {
		margin: var(--space-related) 0 4px;
		font-size: var(--fs-label);
		font-weight: var(--fw-semibold);
	}
</style>
