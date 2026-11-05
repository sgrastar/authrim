<script lang="ts">
	import { ApiError } from '#lib/api/api-error.js';
	import type {
		CreateNoticeChannelInput,
		NoticeChannel,
		NoticeDeliveryClient
	} from '#lib/api/notice-delivery.js';
	import { t } from '#lib/i18n/i18n.svelte.js';
	import Card from '#lib/ui/patterns/Card.svelte';
	import CellText from '#lib/ui/patterns/CellText.svelte';
	import ConfirmDialog from '#lib/ui/patterns/ConfirmDialog.svelte';
	import DataTable from '#lib/ui/patterns/DataTable.svelte';
	import EmptyState from '#lib/ui/patterns/EmptyState.svelte';
	import LoadingState from '#lib/ui/patterns/LoadingState.svelte';
	import ActionMenu, { type MenuAction } from '#lib/ui/primitives/ActionMenu.svelte';
	import Badge from '#lib/ui/primitives/Badge.svelte';
	import Button from '#lib/ui/primitives/Button.svelte';
	import { toast } from '#lib/ui/toast/toast.svelte.js';
	import ReplaceWebhookDialog from './ReplaceWebhookDialog.svelte';
	import SlackChannelDialog from './SlackChannelDialog.svelte';
	import { MIN_SEVERITY_LABEL, channelErrorKey } from './notice-labels';

	/**
	 * Operations → Notifications → "Slack channels": where notices are also posted. Shown to admins
	 * who may read settings; changing needs settings write, and the platform's own channels need
	 * platform authority. A webhook URL is typed once and never read back (only its end is shown).
	 */
	interface Props {
		client: NoticeDeliveryClient;
		canWrite: boolean;
		platform: boolean;
	}

	let { client, canWrite, platform }: Props = $props();

	let items = $state<NoticeChannel[]>([]);
	let phase = $state<'loading' | 'ready' | 'forbidden' | 'failed'>('loading');
	let busy = $state(false);
	let adding = $state(false);
	let addError = $state<string>();
	let replacing = $state<NoticeChannel | null>(null);
	let replaceError = $state<string>();
	let deleting = $state<NoticeChannel | null>(null);

	async function load() {
		phase = 'loading';
		try {
			items = await client.listChannels();
			phase = 'ready';
		} catch (error) {
			phase = error instanceof ApiError && error.status === 403 ? 'forbidden' : 'failed';
		}
	}

	$effect(() => {
		void load();
	});

	function replaceItem(channel: NoticeChannel) {
		items = items.map((item) => (item.id === channel.id ? channel : item));
	}

	/** Runs one change; a failure is a toast unless the dialog that asked shows it. */
	async function run(action: () => Promise<void>, onerror?: (message: string) => void) {
		busy = true;
		try {
			await action();
		} catch (error) {
			const message = t(channelErrorKey(error));
			if (onerror) onerror(message);
			else toast.error(message);
		} finally {
			busy = false;
		}
	}

	const add = (input: CreateNoticeChannelInput) =>
		run(
			async () => {
				const channel = await client.createChannel(input);
				items = [...items, channel];
				adding = false;
				toast.success(t('nt.slack.toast.added'));
			},
			(message) => (addError = message)
		);

	const replaceUrl = (webhookUrl: string) =>
		run(
			async () => {
				if (!replacing) return;
				replaceItem(await client.replaceWebhookUrl(replacing.id, webhookUrl));
				replacing = null;
				toast.success(t('nt.slack.toast.replaced'));
			},
			(message) => (replaceError = message)
		);

	const toggle = (channel: NoticeChannel) =>
		run(async () => {
			replaceItem(await client.updateChannel(channel.id, { enabled: !channel.enabled }));
			toast.success(t(channel.enabled ? 'nt.slack.toast.paused' : 'nt.slack.toast.resumed'));
		});

	const sendTest = (channel: NoticeChannel) =>
		run(async () => {
			const result = await client.testChannel(channel.id);
			if (result.delivered) toast.success(t('nt.slack.toast.testOk'));
			else toast.error(t('nt.slack.toast.testFailed'));
		});

	const remove = () =>
		run(async () => {
			if (!deleting) return;
			await client.deleteChannel(deleting.id);
			const id = deleting.id;
			items = items.filter((item) => item.id !== id);
			toast.success(t('nt.slack.toast.deleted'));
		}).finally(() => (deleting = null));

	const actionsOf = (channel: NoticeChannel): MenuAction[] => [
		{
			label: t('nt.slack.action.test'),
			icon: 'bell',
			disabled: busy,
			onselect: () => void sendTest(channel)
		},
		{
			label: t('nt.slack.action.replace'),
			icon: 'key',
			onselect: () => {
				replaceError = undefined;
				replacing = channel;
			}
		},
		{
			label: t(channel.enabled ? 'nt.slack.action.pause' : 'nt.slack.action.resume'),
			disabled: busy,
			onselect: () => void toggle(channel)
		},
		{
			label: t('nt.slack.action.delete'),
			icon: 'trash',
			danger: true,
			onselect: () => (deleting = channel)
		}
	];

	const columns = $derived([
		{ key: 'name', label: t('nt.slack.col.name') },
		{ key: 'scope', label: t('nt.col.scope'), width: '20%' },
		{ key: 'min', label: t('nt.slack.col.min'), width: '22%' },
		{ key: 'status', label: t('nt.slack.col.status'), width: '14%' },
		...(canWrite
			? [
					{
						key: 'actions',
						label: t('nt.slack.actions', { name: '' }),
						width: '56px',
						hideLabel: true
					}
				]
			: [])
	]);
</script>

<Card title={t('nt.slack.title')} info={t('nt.slack.info')} flush>
	{#snippet actions()}
		{#if canWrite && phase === 'ready'}
			<Button
				size="sm"
				icon="plus"
				onclick={() => {
					addError = undefined;
					adding = true;
				}}>{t('nt.slack.add')}</Button
			>
		{/if}
	{/snippet}
	{#if phase === 'loading'}
		<LoadingState label={t('common.loading')} />
	{:else if phase === 'forbidden'}
		<EmptyState icon="lock" title={t('nt.slack.noAccess')} />
	{:else if phase === 'failed'}
		<EmptyState icon="warningCircle" title={t('nt.slack.loadFailed')}>
			{#snippet action()}
				<Button size="sm" onclick={load}>{t('common.retry')}</Button>
			{/snippet}
		</EmptyState>
	{:else}
		<DataTable caption={t('nt.slack.title')} {columns} rows={items} rowKey={(row) => row.id}>
			{#snippet cell(row, column)}
				{#if column.key === 'name'}
					<CellText
						title={row.name}
						description="{t('nt.slack.col.url')}: {row.webhook_url_hint}"
					/>
				{:else if column.key === 'scope'}
					{row.scope_type === 'platform' ? t('nt.scope.platform') : t('nt.scope.tenant')}
				{:else if column.key === 'min'}
					{t(MIN_SEVERITY_LABEL[row.min_severity])}
				{:else if column.key === 'status'}
					<Badge tone={row.enabled ? 'success' : 'neutral'} dot>
						{row.enabled ? t('nt.slack.on') : t('nt.slack.off')}
					</Badge>
				{:else}
					<ActionMenu
						size="sm"
						label={t('nt.slack.actions', { name: row.name })}
						actions={actionsOf(row)}
					/>
				{/if}
			{/snippet}
			{#snippet empty()}
				<EmptyState icon="bell" title={t('nt.slack.empty')} />
			{/snippet}
		</DataTable>
	{/if}
</Card>

<SlackChannelDialog
	open={adding}
	{platform}
	{busy}
	error={addError}
	onadd={add}
	oncancel={() => (adding = false)}
/>

<ReplaceWebhookDialog
	channel={replacing}
	{busy}
	error={replaceError}
	onreplace={replaceUrl}
	oncancel={() => (replacing = null)}
/>

<ConfirmDialog
	open={deleting !== null}
	title={t('nt.slack.delete.title', { name: deleting?.name ?? '' })}
	body={t('nt.slack.delete.body')}
	confirmLabel={t('nt.slack.action.delete')}
	tone="danger"
	{busy}
	onconfirm={remove}
	oncancel={() => (deleting = null)}
/>
