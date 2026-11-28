<script lang="ts">
	import type { AuthzAccess } from '#lib/access/access.js';
	import type { AdminUsersClient } from '#lib/api/admin-users.js';
	import type { EndUserRebacClient, RebacCheckResult } from '#lib/api/end-user-rebac.js';
	import { t } from '#lib/i18n/i18n.svelte.js';
	import Icon from '#lib/ui/icons/Icon.svelte';
	import Callout from '#lib/ui/patterns/Callout.svelte';
	import Card from '#lib/ui/patterns/Card.svelte';
	import DetailItem from '#lib/ui/patterns/DetailItem.svelte';
	import DetailList from '#lib/ui/patterns/DetailList.svelte';
	import EntityPicker, { type PickerItem } from '#lib/ui/patterns/EntityPicker.svelte';
	import FieldRow from '#lib/ui/patterns/FieldRow.svelte';
	import RowStack from '#lib/ui/patterns/RowStack.svelte';
	import TextRow from '#lib/ui/patterns/TextRow.svelte';
	import Button from '#lib/ui/primitives/Button.svelte';
	import ObjectTypeField from './ObjectTypeField.svelte';
	import {
		EMPTY_CHECK_FORM,
		checkInputOf,
		checkProblems,
		rebacRefusalText,
		resolvedViaKey,
		type CheckForm
	} from './rebac-model';
	import { userSearch } from './user-picker';

	/**
	 * Ask the engine one question: does this user have this relation on this object? The answer
	 * says how it was reached. A check follows the paths the definitions declare, nothing more; and
	 * when the user's group memberships cannot be read it answers “no” and says so, rather than
	 * “no groups”. Nothing is saved.
	 */
	interface Props {
		client: Pick<EndUserRebacClient, 'check'>;
		users: Pick<AdminUsersClient, 'list'>;
		access: AuthzAccess;
		/** The object types the definitions use. */
		objectTypes: readonly string[];
	}

	let { client, users, access, objectTypes }: Props = $props();

	let form = $state<CheckForm>({ ...EMPTY_CHECK_FORM });
	let user = $state<PickerItem[]>([]);
	let tried = $state(false);
	let busy = $state(false);
	let answer = $state<{ asked: string; result: RebacCheckResult } | null>(null);
	let refusal = $state('');

	const searchUsers = $derived(
		userSearch(users, {
			typedAsId: t('az.picker.typedId'),
			searchRefused: t('az.picker.searchRefused'),
			canSearch: access.usersRead
		})
	);
	const filled = $derived<CheckForm>({ ...form, user_id: user[0]?.value ?? '' });
	const problems = $derived(checkProblems(filled));
	const shown = (field: keyof CheckForm) =>
		tried && problems[field] ? t(problems[field]) : undefined;

	let generation = 0;
	async function run() {
		tried = true;
		refusal = '';
		if (Object.keys(problems).length > 0) return;
		const input = checkInputOf(filled);
		// Frozen now: what was asked stays with its answer while the form is edited.
		const asked = t('rb.check.asked', {
			user: user[0]?.label ?? input.user_id,
			relation: input.relation,
			object: `${input.object_type}:${input.object_id}`
		});
		const mine = ++generation;
		busy = true;
		try {
			const result = await client.check(input);
			if (mine !== generation) return;
			answer = { asked, result };
		} catch (failure) {
			if (mine !== generation) return;
			answer = null;
			refusal = rebacRefusalText(failure, 'check', t);
		} finally {
			if (mine === generation) busy = false;
		}
	}

	const shownValue = (value: unknown): string =>
		typeof value === 'string' ? value : JSON.stringify(value);
</script>

{#if !access.rebacWrite}
	<Callout icon="lock">{t('rb.check.noAccess')}</Callout>
{:else}
	<Card title={t('rb.check.title')} description={t('rb.check.desc')}>
		<form
			class="form"
			novalidate
			onsubmit={(event) => {
				event.preventDefault();
				void run();
			}}
		>
			<RowStack>
				<FieldRow label={t('rb.check.user')} required>
					<EntityPicker
						label={t('rb.check.user')}
						placeholder={t('az.picker.placeholder')}
						multiple={false}
						search={searchUsers}
						error={shown('user_id')}
						bind:items={user}
					/>
				</FieldRow>
				<TextRow
					label={t('rb.check.relation')}
					required
					placeholder="viewer"
					error={shown('relation')}
					bind:value={form.relation}
				/>
				<FieldRow label={t('rb.check.objectType')} required plain>
					<ObjectTypeField
						label={t('rb.check.objectType')}
						types={objectTypes}
						required
						error={shown('object_type')}
						bind:value={form.object_type}
					/>
				</FieldRow>
				<TextRow
					label={t('rb.check.objectId')}
					required
					placeholder="doc_1"
					error={shown('object_id')}
					bind:value={form.object_id}
				/>
			</RowStack>
			<div class="actions">
				<Button variant="primary" type="submit" icon="search" loading={busy}>
					{t('rb.check.run')}
				</Button>
			</div>
		</form>
	</Card>

	{#if refusal}
		<Callout tone="danger" live>{refusal}</Callout>
	{/if}

	{#if answer}
		{@const { asked, result } = answer}
		{@const viaKey = resolvedViaKey(result.resolved_via)}
		<Card title={t('rb.check.result')} tone={result.allowed ? 'default' : 'warning'}>
			<div class="verdict" aria-live="polite">
				<Icon name={result.allowed ? 'checkCircle' : 'warningCircle'} />
				<strong>{result.allowed ? t('rb.check.allowed') : t('rb.check.denied')}</strong>
				<span class="muted">{asked}</span>
			</div>
			{#if result.resolved_via === 'unknown_membership'}
				<Callout tone="warning">{t('rb.via.unknown_membership')}</Callout>
			{/if}
			<DetailList columns={2} ruled>
				<DetailItem label={t('rb.check.via')}>
					{#if result.resolved_via}
						<code>{result.resolved_via}</code>
						{#if viaKey && result.resolved_via !== 'unknown_membership'}
							<span class="muted">{t(viaKey)}</span>
						{/if}
					{:else}
						{t('rb.via.none')}
					{/if}
				</DetailItem>
				{#if result.path.length > 0}
					<DetailItem label={t('rb.check.path')}>
						<ol class="path">
							{#each result.path as step, index (index)}
								<li><code>{step}</code></li>
							{/each}
						</ol>
					</DetailItem>
				{/if}
			</DetailList>
			{#if result.debug}
				<h3 class="details-title">{t('rb.check.debug')}</h3>
				<DetailList columns={2} ruled>
					{#each Object.entries(result.debug) as [key, value] (key)}
						<DetailItem label={key}><code>{shownValue(value)}</code></DetailItem>
					{/each}
				</DetailList>
			{/if}
		</Card>
	{/if}
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

	.path {
		margin: 0;
		padding-inline-start: 1.2em;
	}

	.details-title {
		margin: var(--space-related) 0 4px;
		font-size: var(--fs-label);
		font-weight: var(--fw-semibold);
	}
</style>
