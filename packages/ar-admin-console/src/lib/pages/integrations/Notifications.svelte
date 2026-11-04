<script lang="ts">
	import { untrack } from 'svelte';
	import {
		noticeText,
		type AdminNotice,
		type AdminNoticesClient,
		type PublishNoticeInput
	} from '#lib/api/admin-notices.js';
	import { ApiError } from '#lib/api/api-error.js';
	import type { NoticeDeliveryClient } from '#lib/api/notice-delivery.js';
	import { hasPermission } from '#lib/access/access.js';
	import { adminAccess } from '#lib/access/admin-access.svelte.js';
	import { adminSession } from '#lib/auth/session.svelte.js';
	import { hasMessage, t } from '#lib/i18n/i18n.svelte.js';
	import Card from '#lib/ui/patterns/Card.svelte';
	import DataTable from '#lib/ui/patterns/DataTable.svelte';
	import EmptyState from '#lib/ui/patterns/EmptyState.svelte';
	import LoadingState from '#lib/ui/patterns/LoadingState.svelte';
	import PageHeader from '#lib/ui/patterns/PageHeader.svelte';
	import Badge from '#lib/ui/primitives/Badge.svelte';
	import Button from '#lib/ui/primitives/Button.svelte';
	import Page from '#lib/ui/templates/Page.svelte';
	import DateTime from '#lib/ui/time/DateTime.svelte';
	import { toast } from '#lib/ui/toast/toast.svelte.js';
	import NoticeDetail from './NoticeDetail.svelte';
	import PublishNoticeDialog from './PublishNoticeDialog.svelte';
	import SlackChannels from './SlackChannels.svelte';
	import { SEVERITY_LABEL, SEVERITY_TONE, actionErrorKey, scopeLabel } from './notice-labels';

	/**
	 * Operations → Notifications: the notices open for this admin in the selected tenant, with the
	 * detail of one (`focusId`, from the header's link or a click on its row), the action that
	 * closes it, and, for admins who may change settings, a way to publish an announcement.
	 */
	interface Props {
		client: AdminNoticesClient;
		/**
		 * Where notices were delivered and the Slack channels they go to. Offered to admins who may
		 * read settings; without it the page shows neither.
		 */
		delivery?: NoticeDeliveryClient;
		/** The notice to show in full (`?id=`). */
		focusId?: string | null;
		/** Called when the admin opens or closes a notice, so the address can follow. */
		onfocus?: (id: string | null) => void;
		/** Called after a notice was resolved, dismissed or published, so the header can refresh. */
		onchanged?: () => void;
	}

	let { client, delivery, focusId = null, onfocus, onchanged }: Props = $props();

	let items = $state<AdminNotice[]>([]);
	let phase = $state<'loading' | 'ready' | 'forbidden' | 'failed'>('loading');
	let selectedId = $state<string | null>(null);
	/** A notice opened by address that is not in the open list (already handled, say). */
	let fetched = $state<AdminNotice | null>(null);
	let missing = $state(false);
	let busy = $state(false);
	let actionError = $state<string>();
	let publishing = $state(false);
	let publishError = $state<string>();

	const access = $derived(adminAccess.current);
	const canWrite = $derived(hasPermission(access, 'admin:settings:write'));
	const canReadSettings = $derived(hasPermission(access, 'admin:settings:read') || canWrite);
	const deliveryClient = $derived(canReadSettings ? delivery : undefined);
	const selected = $derived(
		selectedId ? (items.find((item) => item.id === selectedId) ?? fetched) : null
	);

	function canResolve(notice: AdminNotice): boolean {
		switch (notice.scope_type) {
			case 'platform':
				return access.platform;
			case 'admin_user':
				return canWrite || notice.admin_user_id === adminSession.current?.user_id;
			default:
				return canWrite;
		}
	}

	let generation = 0;
	async function load(quiet = false) {
		const mine = ++generation;
		if (!quiet) phase = 'loading';
		try {
			const list = await client.list();
			if (mine !== generation) return;
			items = list;
			phase = 'ready';
		} catch (error) {
			if (mine !== generation) return;
			if (quiet) return;
			phase = error instanceof ApiError && error.status === 403 ? 'forbidden' : 'failed';
		}
	}

	$effect(() => {
		void load();
		return () => void generation++;
	});

	// The address says which notice is open; one not in the open list is read on its own.
	$effect(() => {
		const id = focusId;
		selectedId = id;
		fetched = null;
		missing = false;
		actionError = undefined;
		if (!id || phase !== 'ready' || untrack(() => items.some((item) => item.id === id))) return;
		let current = true;
		client
			.get(id)
			.then((notice) => current && (fetched = notice))
			.catch(() => current && (missing = true));
		return () => (current = false);
	});

	function open(id: string | null) {
		selectedId = id;
		fetched = null;
		missing = false;
		actionError = undefined;
		onfocus?.(id);
	}

	async function run(action: () => Promise<void>) {
		busy = true;
		actionError = undefined;
		try {
			await action();
			onchanged?.();
		} catch (error) {
			actionError = t(actionErrorKey(error));
			// Somebody else may have handled it already: show what is true now.
			if (error instanceof ApiError && error.status === 409) void load(true);
		} finally {
			busy = false;
		}
	}

	const resolve = (notice: AdminNotice) =>
		run(async () => {
			const done = await client.resolve(notice.id);
			items = items.filter((item) => item.id !== notice.id);
			fetched = done;
			toast.success(t('nt.toast.resolved'));
		});

	const dismiss = (notice: AdminNotice) =>
		run(async () => {
			await client.dismiss(notice.id);
			items = items.filter((item) => item.id !== notice.id);
			toast.success(t('nt.toast.dismissed'));
			open(null);
		});

	async function publish(input: PublishNoticeInput) {
		busy = true;
		publishError = undefined;
		try {
			const notice = await client.publish(input);
			items = [notice, ...items];
			publishing = false;
			toast.success(t('nt.toast.published'));
			onchanged?.();
		} catch (error) {
			publishError =
				error instanceof ApiError && error.status === 400
					? t('nt.pub.err.invalid')
					: t(actionErrorKey(error));
		} finally {
			busy = false;
		}
	}

	const nameOf = (notice: AdminNotice) => noticeText(notice, { t, hasMessage });
</script>

<Page>
	<PageHeader title={t('nt.page')} description={t('nt.page.desc')}>
		{#snippet actions()}
			{#if canWrite}
				<Button
					variant="primary"
					icon="plus"
					onclick={() => {
						publishError = undefined;
						publishing = true;
					}}>{t('nt.publish')}</Button
				>
			{/if}
		{/snippet}
	</PageHeader>

	{#if phase === 'loading'}
		<LoadingState label={t('common.loading')} />
	{:else if phase === 'forbidden'}
		<EmptyState icon="lock" title={t('nt.noAccess')} />
	{:else if phase === 'failed'}
		<EmptyState icon="warningCircle" title={t('nt.loadFailed')}>
			{#snippet action()}
				<Button size="sm" onclick={() => load()}>{t('common.retry')}</Button>
			{/snippet}
		</EmptyState>
	{:else}
		{#if selected}
			<NoticeDetail
				notice={selected}
				canResolve={canResolve(selected)}
				delivery={deliveryClient}
				{busy}
				error={actionError}
				onresolve={() => resolve(selected)}
				ondismiss={() => dismiss(selected)}
				onclose={() => open(null)}
			/>
		{:else if selectedId && missing}
			<EmptyState icon="warningCircle" title={t('nt.detail.missing')}>
				{#snippet action()}
					<Button size="sm" onclick={() => open(null)}>{t('nt.detail.close')}</Button>
				{/snippet}
			</EmptyState>
		{/if}

		<Card title={t('nt.open.title')} info={t('nt.open.info')} flush>
			<DataTable
				caption={t('nt.open.title')}
				columns={[
					{ key: 'severity', label: t('nt.col.severity'), width: '14%' },
					{ key: 'message', label: t('nt.col.message') },
					{ key: 'scope', label: t('nt.col.scope'), width: '20%' },
					{ key: 'time', label: t('nt.col.time'), width: '22%' }
				]}
				rows={items}
				rowKey={(row) => row.id}
				onrowopen={(row) => open(row.id)}
				rowOpenLabel={(row) => t('nt.row.open', { name: nameOf(row) })}
			>
				{#snippet cell(row, column)}
					{#if column.key === 'severity'}
						<Badge tone={SEVERITY_TONE[row.severity]}>{t(SEVERITY_LABEL[row.severity])}</Badge>
					{:else if column.key === 'message'}
						{nameOf(row)}
					{:else if column.key === 'scope'}
						{scopeLabel(row, t)}
					{:else}
						<DateTime value={row.created_at} stacked />
					{/if}
				{/snippet}
				{#snippet empty()}
					<EmptyState icon="bell" title={t('nt.empty')} />
				{/snippet}
			</DataTable>
		</Card>

		{#if deliveryClient}
			<SlackChannels client={deliveryClient} {canWrite} platform={access.platform} />
		{/if}
	{/if}
</Page>

<PublishNoticeDialog
	open={publishing}
	platform={access.platform}
	{busy}
	error={publishError}
	onpublish={publish}
	oncancel={() => (publishing = false)}
/>
