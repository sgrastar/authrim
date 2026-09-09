<script lang="ts">
	import { LL } from '$i18n/i18n-svelte';
	import { listGuestLifecycle, type GuestLifecycleItem } from '$lib/api/admin-guest-lifecycle';
	import AdminSection from './AdminSection.svelte';
	let { tenantId } = $props<{ tenantId: string }>();
	let items = $state<GuestLifecycleItem[]>([]);
	let cursor = $state<string | null>(null);
	let busy = $state(false);
	let failed = $state(false);
	let generation = 0;
	$effect(() => {
		const tenant = tenantId;
		generation++;
		items = [];
		cursor = null;
		void load(tenant);
	});
	async function load(tenant: string, next?: string) {
		const request = ++generation;
		busy = true;
		failed = false;
		try {
			const result = await listGuestLifecycle(tenant, next);
			if (request !== generation) return;
			items = next ? [...items, ...result.items] : result.items;
			cursor = result.next_cursor;
		} catch {
			if (request === generation) failed = true;
		} finally {
			if (request === generation) busy = false;
		}
	}
	const date = (value: number | null) =>
		value === null ? '—' : new Date(value * 1000).toLocaleString();
</script>

<AdminSection title={$LL.admin_lifecycle_progressTitle()}>
	<p>{$LL.admin_lifecycle_progressHelp()}</p>
	<button type="button" class="btn btn-secondary" disabled={busy} onclick={() => load(tenantId)}
		>{$LL.admin_lifecycle_refresh()}</button
	>
	{#if failed}<p role="alert">{$LL.admin_lifecycle_progressError()}</p>{/if}
	<div class="overflow">
		<table>
			<thead
				><tr
					><th>{$LL.admin_lifecycle_subject()}</th><th>{$LL.admin_lifecycle_phase()}</th><th
						>{$LL.admin_lifecycle_due()}</th
					><th>{$LL.admin_lifecycle_delay()}</th><th>{$LL.admin_lifecycle_attempt()}</th></tr
				></thead
			>
			<tbody
				>{#each items as item (item.user_id)}
					<tr
						><td>{item.user_id}</td><td>{$LL.admin_lifecycle_phaseValue({ phase: item.phase })}</td
						><td>{date(item.deletion_due_at)}</td><td>{Math.ceil(item.overdue_seconds / 60)}</td><td
							>{item.maintenance
								? $LL.admin_lifecycle_maintenanceValue({ state: item.maintenance.state })
								: '—'}
							{date(item.maintenance?.attempted_at ?? null)}</td
						></tr
					>
				{/each}</tbody
			>
		</table>
	</div>
	{#if !busy && !failed && items.length === 0}<p>{$LL.admin_lifecycle_noAccounts()}</p>{/if}
	{#if cursor}<button
			type="button"
			class="btn btn-secondary"
			disabled={busy}
			onclick={() => load(tenantId, cursor ?? undefined)}>{$LL.admin_lifecycle_loadMore()}</button
		>{/if}
</AdminSection>

<style>
	.overflow {
		overflow-x: auto;
	}
	table {
		width: 100%;
		border-collapse: collapse;
	}
	th,
	td {
		text-align: left;
		padding: 0.75rem;
		border-bottom: 1px solid var(--border-color);
	}
</style>
