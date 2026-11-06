<script lang="ts">
	/**
	 * The open security-key recovery requests of the tenant's other admins, which any of them can
	 * cancel during the waiting period. Shown only while there is one; an admin who may not read
	 * the tenant's admins sees nothing.
	 */
	import { ApiError } from '#lib/api/api-error.js';
	import type { SecondFactorsClient, TenantRecoveryRequest } from '#lib/api/second-factors.js';
	import { t } from '#lib/i18n/i18n.svelte.js';
	import Card from '#lib/ui/patterns/Card.svelte';
	import ConfirmDialog from '#lib/ui/patterns/ConfirmDialog.svelte';
	import DataTable from '#lib/ui/patterns/DataTable.svelte';
	import EmptyState from '#lib/ui/patterns/EmptyState.svelte';
	import Button from '#lib/ui/primitives/Button.svelte';
	import DateTime from '#lib/ui/time/DateTime.svelte';
	import { toast } from '#lib/ui/toast/toast.svelte.js';

	interface Props {
		client: SecondFactorsClient;
		/** The signed-in admin, whose own request is shown in Security keys instead. */
		selfId?: string;
		/** Whether this admin may cancel them (admin users write). */
		canCancel?: boolean;
	}

	let { client, selfId, canCancel = false }: Props = $props();

	let requests = $state<TenantRecoveryRequest[]>([]);
	let loadState = $state<'loading' | 'ready' | 'failed' | 'hidden'>('loading');
	let cancelling = $state<TenantRecoveryRequest | null>(null);
	let busy = $state(false);

	const others = $derived(requests.filter((request) => request.admin_user_id !== selfId));

	async function load() {
		try {
			requests = await client.listTenantRecoveries();
			loadState = 'ready';
		} catch (error) {
			loadState = error instanceof ApiError && error.forbidden ? 'hidden' : 'failed';
		}
	}

	$effect(() => {
		load();
	});

	async function cancel() {
		const target = cancelling;
		if (!target) return;
		busy = true;
		try {
			await client.cancelTenantRecovery(target.id);
			toast.success(t('sk.others.cancelled'));
			await load();
		} catch (error) {
			toast.error(
				t(error instanceof ApiError && error.forbidden ? 'sk.others.noPermission' : 'sk.error')
			);
		} finally {
			busy = false;
			cancelling = null;
		}
	}

	const columns = $derived([
		{ key: 'admin', label: t('sk.others.admin') },
		{ key: 'kind', label: t('sk.others.kind') },
		{ key: 'requested', label: t('sk.others.requested') },
		{ key: 'notBefore', label: t('sk.others.notBefore') },
		...(canCancel
			? [{ key: 'actions', label: t('sk.others.cancel'), align: 'end' as const, hideLabel: true }]
			: [])
	]);
</script>

{#if loadState === 'failed'}
	<Card title={t('sk.others.title')}>
		<EmptyState icon="warningCircle" title={t('sk.others.loadFailed')}>
			{#snippet action()}
				<Button size="sm" onclick={load}>{t('common.retry')}</Button>
			{/snippet}
		</EmptyState>
	</Card>
{:else if loadState === 'ready' && others.length > 0}
	<Card title={t('sk.others.title')} info={t('sk.others.info')} tone="warning" flush>
		<DataTable caption={t('sk.others.title')} {columns} rows={others} rowKey={(row) => row.id}>
			{#snippet cell(row, column)}
				{#if column.key === 'admin'}
					<span dir="ltr">{row.admin_email ?? row.admin_user_id}</span>
				{:else if column.key === 'kind'}
					{t(row.kind === 'keyring_holder_key' ? 'kp.kind.keyring' : 'kp.kind.securityKey')}
				{:else if column.key === 'requested'}
					<DateTime value={row.requested_at} />
				{:else if column.key === 'notBefore'}
					<DateTime value={row.not_before} />
				{:else}
					<Button size="sm" variant="danger" onclick={() => (cancelling = row)}>
						{t('sk.others.cancel')}
					</Button>
				{/if}
			{/snippet}
		</DataTable>
	</Card>
{/if}

<ConfirmDialog
	open={cancelling !== null}
	title={t('sk.others.cancelTitle', { email: cancelling?.admin_email ?? '' })}
	body={t('sk.others.cancelBody')}
	confirmLabel={t('sk.others.cancel')}
	tone="danger"
	{busy}
	onconfirm={cancel}
	oncancel={() => (cancelling = null)}
/>
