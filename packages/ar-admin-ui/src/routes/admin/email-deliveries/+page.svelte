<script lang="ts">
	import { onMount } from 'svelte';
	import { LL } from '$i18n/i18n-svelte';
	import { settingsContext } from '$lib/stores/settings-context.svelte';
	import {
		adminEmailDeliveriesAPI,
		type EmailDeliveryRecord
	} from '$lib/api/admin-email-deliveries';
	import AdminPageHeader from '$lib/components/admin/AdminPageHeader.svelte';
	import AdminPageShell from '$lib/components/admin/AdminPageShell.svelte';
	import AdminSection from '$lib/components/admin/AdminSection.svelte';
	import EmailDeliveryTable from '$lib/components/admin/EmailDeliveryTable.svelte';

	let items = $state<EmailDeliveryRecord[]>([]);
	let loading = $state(true);
	let error = $state('');
	let status = $state('');
	let loadedTenantId = $state('');

	async function load() {
		loading = true;
		error = '';
		try {
			items = (await adminEmailDeliveriesAPI.list(status || undefined)).items;
		} catch (err) {
			error = err instanceof Error ? err.message : $LL.admin_email_deliveries_load_failed();
		} finally {
			loading = false;
		}
	}

	onMount(() => settingsContext.initialize());
	$effect(() => {
		const tenantId = settingsContext.tenantId;
		if (!tenantId || tenantId === loadedTenantId) return;
		loadedTenantId = tenantId;
		void load();
	});
</script>

<svelte:head><title>{$LL.admin_email_deliveries_head_title()}</title></svelte:head>

{#snippet actions()}
	<button class="btn btn-secondary" onclick={load} disabled={loading}>
		<i class="i-ph-arrow-clockwise"></i>{$LL.admin_email_deliveries_refresh()}
	</button>
{/snippet}

<AdminPageShell>
	<AdminPageHeader
		title={$LL.admin_email_deliveries_title()}
		description={$LL.admin_email_deliveries_description()}
		{actions}
	/>
	<AdminSection>
		<div class="admin-field admin-field--compact">
			<label class="admin-field__label" for="delivery-status"
				>{$LL.admin_email_deliveries_filter_status()}</label
			>
			<select id="delivery-status" class="admin-select" bind:value={status} onchange={load}>
				<option value="">{$LL.admin_email_deliveries_all_statuses()}</option>
				<option value="requested">{$LL.admin_email_deliveries_status_requested()}</option>
				<option value="retrying">{$LL.admin_email_deliveries_status_retrying()}</option>
				<option value="provider_accepted"
					>{$LL.admin_email_deliveries_status_provider_accepted()}</option
				>
				<option value="delivered">{$LL.admin_email_deliveries_status_delivered()}</option>
				<option value="deferred">{$LL.admin_email_deliveries_status_deferred()}</option>
				<option value="bounced">{$LL.admin_email_deliveries_status_bounced()}</option>
				<option value="failed">{$LL.admin_email_deliveries_status_failed()}</option>
				<option value="rejected">{$LL.admin_email_deliveries_status_rejected()}</option>
				<option value="complained">{$LL.admin_email_deliveries_status_complained()}</option>
				<option value="unknown">{$LL.admin_email_deliveries_status_unknown()}</option>
				<option value="expired">{$LL.admin_email_deliveries_status_expired()}</option>
				<option value="canceled">{$LL.admin_email_deliveries_status_canceled()}</option>
			</select>
		</div>
	</AdminSection>
	<AdminSection
		title={$LL.admin_email_deliveries_history()}
		description={$LL.admin_email_deliveries_history_description()}
	>
		{#if error}<div class="alert alert-error">{error}</div>{/if}
		{#if loading}<p class="state-text">
				{$LL.admin_email_deliveries_loading()}
			</p>{:else}<EmailDeliveryTable {items} />{/if}
	</AdminSection>
</AdminPageShell>
