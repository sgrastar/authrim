<script lang="ts">
	import { untrack } from 'svelte';
	import type { AuthzAccess } from '#lib/access/access.js';
	import type { AccessCheckClient, AccessCheckResult } from '#lib/api/access-check.js';
	import type { AdminUsersClient } from '#lib/api/admin-users.js';
	import type { EndUserGroupsClient } from '#lib/api/end-user-groups.js';
	import { t } from '#lib/i18n/i18n.svelte.js';
	import Callout from '#lib/ui/patterns/Callout.svelte';
	import Card from '#lib/ui/patterns/Card.svelte';
	import DetailItem from '#lib/ui/patterns/DetailItem.svelte';
	import DetailList from '#lib/ui/patterns/DetailList.svelte';
	import EmptyState from '#lib/ui/patterns/EmptyState.svelte';
	import EntityPicker, { type PickerItem } from '#lib/ui/patterns/EntityPicker.svelte';
	import FieldRow from '#lib/ui/patterns/FieldRow.svelte';
	import PageHeader from '#lib/ui/patterns/PageHeader.svelte';
	import RowStack from '#lib/ui/patterns/RowStack.svelte';
	import TextRow from '#lib/ui/patterns/TextRow.svelte';
	import Badge from '#lib/ui/primitives/Badge.svelte';
	import Button from '#lib/ui/primitives/Button.svelte';
	import Icon from '#lib/ui/icons/Icon.svelte';
	import Page from '#lib/ui/templates/Page.svelte';
	import { refusalText } from './authz-errors';
	import {
		EMPTY_FORM,
		askedCheck,
		checkInput,
		formProblems,
		viaLabel,
		type AccessCheckForm,
		type AskedCheck
	} from './access-check-model';
	import { groupSearch, userSearch } from './user-picker';

	/**
	 * Access → Access check: whether one user may do something, as the Check API would answer a
	 * service's backend, with why (the roles, groups or relationships that allowed it, the rules
	 * matched, how long it took). Nothing is written; it answers whatever the Check API switch.
	 */
	interface Props {
		client: AccessCheckClient;
		users: Pick<AdminUsersClient, 'list'>;
		/** Finds the resource's group. */
		groups: Pick<EndUserGroupsClient, 'list'>;
		access: AuthzAccess;
		/** A user to check first (from a user's page). */
		subjectId?: string;
	}

	let { client, users, groups, access, subjectId }: Props = $props();

	let form = $state<AccessCheckForm>({ ...EMPTY_FORM });
	let subject = $state<PickerItem[]>(
		untrack(() => (subjectId ? [{ value: subjectId, label: subjectId, icon: 'userCircle' }] : []))
	);
	let resourceGroup = $state<PickerItem[]>([]);
	let tried = $state(false);
	let busy = $state(false);
	/** The last answer, with what was asked frozen when it was sent. */
	let answer = $state<{ asked: AskedCheck; result: AccessCheckResult } | null>(null);
	let refusal = $state('');

	const search = $derived(
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
	const current = $derived({
		...form,
		subject_id: subject[0]?.value ?? '',
		resource_group_id: resourceGroup[0]?.value ?? ''
	});
	const problems = $derived(formProblems(current));

	let generation = 0;
	async function run() {
		tried = true;
		refusal = '';
		if (Object.keys(problems).length > 0) return;
		// Frozen now: changing the form while the check runs (or after) changes nothing shown.
		const asked = askedCheck(current, subject[0]?.label ?? '', resourceGroup[0]?.label ?? '');
		const input = checkInput(current);
		const mine = ++generation;
		busy = true;
		try {
			const result = await client.check(input);
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
</script>

<Page>
	<PageHeader title={t('nav.access.accessCheck')} description={t('acc.page.desc')} />

	{#if !access.check}
		<EmptyState icon="lock" title={t('acc.noAccess')} />
	{:else}
		<Card title={t('acc.form.title')}>
			<form
				class="form"
				novalidate
				onsubmit={(event) => {
					event.preventDefault();
					void run();
				}}
			>
				<RowStack>
					<FieldRow label={t('acc.form.subject')} required>
						<EntityPicker
							label={t('acc.form.subject')}
							placeholder={t('az.picker.placeholder')}
							multiple={false}
							{search}
							error={tried && problems.subject ? t(problems.subject) : undefined}
							bind:items={subject}
						/>
					</FieldRow>
					<TextRow
						label={t('acc.form.permission')}
						required
						placeholder="documents:read"
						hint={t('acc.form.permissionHint')}
						error={tried && problems.permission ? t(problems.permission) : undefined}
						bind:value={form.permission}
					/>
					<TextRow
						label={t('acc.form.resourceId')}
						hint={t('acc.form.resourceIdHint')}
						error={tried && problems.resource ? t(problems.resource) : undefined}
						bind:value={form.resource_id}
					/>
					<FieldRow label={t('acc.form.resourceGroup')} info={t('acc.form.resourceGroupHint')}>
						<EntityPicker
							label={t('acc.form.resourceGroup')}
							placeholder={t('az.picker.groupPlaceholder')}
							multiple={false}
							search={searchGroups}
							bind:items={resourceGroup}
						/>
					</FieldRow>
					<TextRow
						label={t('acc.form.rebacRelation')}
						hint={t('acc.form.rebacRelationHint')}
						placeholder="viewer"
						error={tried && problems.rebac ? t(problems.rebac) : undefined}
						bind:value={form.rebac_relation}
					/>
					<TextRow
						label={t('acc.form.rebacObject')}
						hint={t('acc.form.rebacObjectHint')}
						placeholder="document:42"
						bind:value={form.rebac_object}
					/>
				</RowStack>
				<div class="actions">
					<Button variant="primary" type="submit" icon="search" loading={busy}>
						{t('acc.form.run')}
					</Button>
				</div>
			</form>
		</Card>

		{#if refusal}
			<Callout tone="danger" live>{refusal}</Callout>
		{/if}

		{#if answer}
			{@const { asked, result } = answer}
			<Card title={t('acc.result.title')} tone={result.allowed ? 'default' : 'warning'}>
				<div class="verdict" aria-live="polite">
					<Icon name={result.allowed ? 'checkCircle' : 'warningCircle'} />
					<strong>{result.allowed ? t('acc.result.allowed') : t('acc.result.denied')}</strong>
					<span class="muted">
						{t('acc.result.asked', { subject: asked.subjectLabel, permission: asked.permission })}
					</span>
				</div>
				<DetailList columns={2} ruled>
					<DetailItem label={t('acc.form.subject')}>
						{asked.subjectLabel}{#if asked.subjectLabel !== asked.subjectId}
							<code class="muted">{asked.subjectId}</code>{/if}
					</DetailItem>
					<DetailItem label={t('acc.form.permission')}><code>{asked.permission}</code></DetailItem>
					{#if asked.resourceId}
						<DetailItem label={t('acc.form.resourceId')}><code>{asked.resourceId}</code></DetailItem
						>
					{/if}
					{#if asked.resourceGroup}
						<DetailItem label={t('acc.form.resourceGroup')}>{asked.resourceGroup}</DetailItem>
					{/if}
					{#if asked.rebac}
						<DetailItem label={t('acc.form.rebacRelation')}><code>{asked.rebac}</code></DetailItem>
					{/if}
					<DetailItem label={t('acc.result.via')}>
						{#if result.resolved_via.length === 0}
							{t('acc.result.viaNone')}
						{:else}
							<span class="badges">
								{#each result.resolved_via as via (via)}
									{@const key = viaLabel(via)}
									<Badge tone="info">{key ? t(key) : via}</Badge>
								{/each}
							</span>
						{/if}
					</DetailItem>
					<DetailItem label={t('acc.result.time')}>
						{result.evaluation_time_ms === null
							? '—'
							: t('acc.result.ms', { ms: result.evaluation_time_ms.toFixed(1) })}
					</DetailItem>
					{#if result.reason}
						<DetailItem label={t('acc.result.reason')}><code>{result.reason}</code></DetailItem>
					{/if}
				</DetailList>
				<h3 class="trace-title">{t('acc.result.trace')}</h3>
				{#if result.matched_rules.length === 0 && result.path.length === 0}
					<p class="muted">{t('acc.result.traceEmpty')}</p>
				{:else}
					<ol class="trace">
						{#each result.matched_rules as rule, index (`rule-${index}`)}
							<li><Badge>{t('acc.result.rule')}</Badge> <code>{rule}</code></li>
						{/each}
						{#each result.path as step, index (`path-${index}`)}
							<li><Badge>{t('acc.result.path')}</Badge> <code>{step}</code></li>
						{/each}
					</ol>
				{/if}
			</Card>
		{/if}
	{/if}
</Page>

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

	.badges {
		display: inline-flex;
		flex-wrap: wrap;
		gap: 4px;
	}

	.trace-title {
		margin: var(--space-related) 0 4px;
		font-size: var(--fs-label);
		font-weight: var(--fw-semibold);
	}

	.trace {
		display: grid;
		gap: 4px;
		margin: 0;
		padding: 0;
		list-style: none;
	}
</style>
