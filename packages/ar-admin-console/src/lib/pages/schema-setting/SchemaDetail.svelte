<script lang="ts">
	import { t } from '$lib/i18n/i18n.svelte';
	import {
		failureOf,
		type SchemaDetail as Detail,
		type SchemaSettingClient
	} from '$lib/api/schema-setting';
	import Callout from '$lib/ui/patterns/Callout.svelte';
	import Card from '$lib/ui/patterns/Card.svelte';
	import ConfirmDialog from '$lib/ui/patterns/ConfirmDialog.svelte';
	import DetailItem from '$lib/ui/patterns/DetailItem.svelte';
	import DetailList from '$lib/ui/patterns/DetailList.svelte';
	import LoadingState from '$lib/ui/patterns/LoadingState.svelte';
	import PageHeader from '$lib/ui/patterns/PageHeader.svelte';
	import Badge from '$lib/ui/primitives/Badge.svelte';
	import BackLink from '$lib/ui/primitives/BackLink.svelte';
	import Button from '$lib/ui/primitives/Button.svelte';
	import { Draft } from '$lib/ui/save/draft.svelte';
	import { toast } from '$lib/ui/toast/toast.svelte';
	import DateTime from '$lib/ui/time/DateTime.svelte';
	import Page from '$lib/ui/templates/Page.svelte';
	import DeleteDialog from './DeleteDialog.svelte';
	import { changeOf, formOf, type EditForm } from './edit-model';
	import HistoryPanel from './HistoryPanel.svelte';
	import { FAILURE_KEY, statusBadge } from './labels';
	import OperationNotice from './OperationNotice.svelte';
	import RenameDialog from './RenameDialog.svelte';
	import SchemaForm from './SchemaForm.svelte';
	import UsagePanel from './UsagePanel.svelte';

	/**
	 * One attribute: what it is, how it is validated and asked for at sign-up, where it is relied
	 * on, what was changed and when. Settings are confirmed with Save, sending only what differs.
	 * The key is changed (renamed) and the attribute deleted by their own actions below, because
	 * both move or remove people's saved values and cannot be part of a Save.
	 *
	 * A base attribute keeps its key, label, type, value count and personal-data flag locked; one
	 * that is being worked on or has failed cannot be changed until that is resolved.
	 */
	interface Props {
		client: SchemaSettingClient;
		tenantId: string;
		id: string;
		/** May change it (the settings write permission). */
		canWrite?: boolean;
		onback: () => void;
		/** Whether something is unsaved or saving, for a page that moves in place. */
		onstate?: (state: { dirty: boolean; saving: boolean }) => void;
	}

	let { client, tenantId, id, canWrite = false, onback, onstate }: Props = $props();

	let detail = $state<Detail | null>(null);
	let draft = $state<Draft<EditForm> | null>(null);
	let phase = $state<'loading' | 'ready' | 'missing' | 'forbidden' | 'failed'>('loading');
	/** A save is running: going back would leave it to finish unseen. */
	let saving = $state(false);
	let attempted = $state(false);

	let renaming = $state(false);
	let deleting = $state(false);
	let leaving = $state(false);

	/** Each load counts up; an answer for an older attribute or tenant is dropped. */
	let generation = 0;

	async function load() {
		const mine = ++generation;
		phase = 'loading';
		try {
			const read = await client.get(tenantId, id);
			if (mine !== generation) return;
			detail = read;
			draft = new Draft(formOf(read.schema));
			attempted = false;
			phase = 'ready';
		} catch (failure) {
			if (mine !== generation) return;
			const { kind } = failureOf(failure);
			phase = kind === 'not_found' ? 'missing' : kind === 'forbidden' ? 'forbidden' : 'failed';
		}
	}

	$effect(() => {
		void [tenantId, id];
		void load();
	});

	const schema = $derived(detail?.schema ?? null);
	const settled = $derived(schema?.status === 'active');
	/** Nothing can be changed: no permission, or the attribute is busy or failed. */
	const frozen = $derived(!canWrite || !settled);
	/** A base attribute's identity is locked on top of that. */
	const identityLocked = $derived(frozen || !!schema?.isSystem);

	async function save(value: EditForm) {
		if (!detail || !draft) return;
		const change = changeOf(detail.schema, value);
		if (Object.keys(change).length === 0) return;
		try {
			const updated = await client.update(tenantId, detail.schema.id, change);
			// The answer to a save carries no usage; it did not change.
			detail = {
				...detail,
				schema: { ...updated, usage: detail.schema.usage, inUse: detail.schema.inUse }
			};
			draft.value = formOf(updated);
			attempted = false;
			toast.success(t('ss.saved'));
		} catch (failure) {
			throw new Error(t(FAILURE_KEY[failureOf(failure).kind]));
		}
	}

	function goBack() {
		if (saving) return;
		if (draft?.dirty) leaving = true;
		else onback();
	}

	function relay(state: { dirty: boolean; saving: boolean }) {
		saving = state.saving;
		onstate?.(state);
	}

	function renamed(result: { oldKey: string; newKey: string; affectedUsers: number }) {
		renaming = false;
		toast.success(
			t('ss.rename.done', {
				old: result.oldKey,
				new: result.newKey,
				count: result.affectedUsers
			})
		);
		void load();
	}

	function deleted() {
		deleting = false;
		toast.success(t('ss.delete.done'));
		onback();
	}

	function deactivated() {
		deleting = false;
		toast.success(t('ss.delete.deactivated'));
		void load();
	}

	/** Closes the dialog and reads the attribute again: it may now be marked as failed. */
	function failed(message: string) {
		renaming = false;
		deleting = false;
		toast.error(message);
		void load();
	}

	const usersText = (read: Detail) =>
		read.userCount < 0
			? t('ss.fact.usersUnknown')
			: read.userCountApproximate
				? t('ss.fact.usersApproximate', { count: read.userCount })
				: String(read.userCount);
</script>

<Page>
	{#if phase === 'loading'}
		<LoadingState label={t('ss.title')} />
	{:else if phase !== 'ready' || !schema || !draft || !detail}
		<PageHeader title={t('ss.title')}>
			{#snippet back()}
				<BackLink onclick={onback}>{t('ss.detail.back')}</BackLink>
			{/snippet}
		</PageHeader>
		<Callout tone="danger" live>
			{t(
				phase === 'missing'
					? 'ss.detail.notFound'
					: phase === 'forbidden'
						? 'ss.noAccess'
						: 'ss.detail.loadFailed'
			)}
			{#if phase === 'failed'}
				<Button size="sm" variant="secondary" onclick={load}>{t('common.retry')}</Button>
			{/if}
		</Callout>
	{:else}
		{@const badge = statusBadge(schema)}
		<PageHeader title={schema.label} description={schema.description ?? undefined}>
			{#snippet back()}
				<BackLink onclick={goBack}>{t('ss.detail.back')}</BackLink>
			{/snippet}
			{#snippet badges()}
				<Badge tone={schema.isSystem ? 'info' : 'neutral'}
					>{t(schema.isSystem ? 'ss.origin.system' : 'ss.origin.custom')}</Badge
				>
				{#if schema.isPii}<Badge tone="warning">{t('ss.pii.yes')}</Badge>{/if}
				<Badge tone={badge.tone} dot>{t(badge.key)}</Badge>
			{/snippet}
		</PageHeader>

		<OperationNotice {schema} {client} {tenantId} {canWrite} onchanged={load} />
		{#if canWrite && !settled && schema.status !== 'error'}
			<p class="note">{t('ss.locked.busy')}</p>
		{/if}
		{#if schema.isSystem}<Callout tone="info">{t('ss.locked.system')}</Callout>{/if}

		<SchemaForm
			{draft}
			{schema}
			{frozen}
			{identityLocked}
			{canWrite}
			{settled}
			bind:attempted
			onsave={save}
			onrename={() => (renaming = true)}
			onstate={relay}
		/>

		<Card title={t('ss.section.facts')}>
			<DetailList ruled>
				<DetailItem label={t('ss.fact.version')}>{schema.version}</DetailItem>
				<DetailItem label={t('ss.fact.storage')}
					>{t(schema.isPii ? 'ss.fact.storagePii' : 'ss.fact.storageCore')}</DetailItem
				>
				<DetailItem label={t('ss.fact.users')}>
					{usersText(detail)}
					{#if schema.isPii}<span class="muted">{t('ss.fact.usersPii')}</span>{/if}
				</DetailItem>
				<DetailItem label={t('ss.fact.created')}><DateTime value={schema.createdAt} /></DetailItem>
				<DetailItem label={t('ss.fact.updated')}><DateTime value={schema.updatedAt} /></DetailItem>
				{#if schema.createdBy}
					<DetailItem label={t('ss.fact.createdBy')}>{schema.createdBy}</DetailItem>
				{/if}
			</DetailList>
		</Card>

		<UsagePanel usage={schema.usage} />
		<HistoryPanel {client} {tenantId} schemaId={schema.id} version={schema.version} />

		{#if canWrite}
			<Card title={t('ss.section.danger')}>
				<div class="actions">
					{#if !schema.isSystem}
						<div class="action">
							<div>
								<strong>{t('ss.rename.action')}</strong>
								<p class="muted">{t('ss.rename.actionHint')}</p>
							</div>
							<Button
								variant="secondary"
								disabled={!settled || draft.dirty}
								onclick={() => (renaming = true)}>{t('ss.rename.action')}</Button
							>
						</div>
					{/if}
					<div class="action">
						<div>
							<strong>{t('ss.delete.action')}</strong>
							<p class="muted">
								{schema.isSystem ? t('ss.delete.disabledSystem') : t('ss.delete.actionHint')}
							</p>
						</div>
						<Button
							variant="danger"
							icon="trash"
							disabled={!settled || schema.isSystem || draft.dirty}
							onclick={() => (deleting = true)}>{t('ss.delete.action')}</Button
						>
					</div>
					{#if draft.dirty}<p class="muted">{t('ss.dirty.firstSave')}</p>{/if}
				</div>
			</Card>
		{/if}

		<RenameDialog
			{client}
			{tenantId}
			{schema}
			userCount={detail.userCount}
			open={renaming}
			oncancel={() => (renaming = false)}
			onrenamed={renamed}
			onfailed={failed}
		/>
		<DeleteDialog
			{client}
			{tenantId}
			{schema}
			userCount={detail.userCount}
			open={deleting}
			oncancel={() => (deleting = false)}
			ondeleted={deleted}
			ondeactivated={deactivated}
			onfailed={failed}
		/>
		<ConfirmDialog
			open={leaving}
			title={t('ss.unsaved.title')}
			body={t('ss.unsaved.body')}
			confirmLabel={t('ss.unsaved.confirm')}
			cancelLabel={t('ss.unsaved.keep')}
			tone="danger"
			onconfirm={() => {
				leaving = false;
				onback();
			}}
			oncancel={() => (leaving = false)}
		/>
	{/if}
</Page>

<style>
	.muted,
	.note {
		margin: 0;
		color: var(--text-secondary);
		font-size: var(--fs-small);
	}

	.actions {
		display: flex;
		flex-direction: column;
		gap: 16px;
	}

	.action {
		display: flex;
		flex-wrap: wrap;
		gap: 12px var(--space-columns);
		align-items: center;
		justify-content: space-between;
	}

	.action p {
		margin: 2px 0 0;
	}
</style>
