<script lang="ts">
	import type { AdminAccess } from '$lib/access/access';
	import type { SettingsClient } from '$lib/api/settings';
	import type { TenantInfoClient } from '$lib/api/tenant-info';
	import { TENANT_GENERAL } from '$lib/settings/placement';
	import SettingsPage from '$lib/settings/SettingsPage.svelte';
	import TenantInfoPanel from './TenantInfoPanel.svelte';

	/**
	 * Settings → General. The logo is a setting (a placement, SettingsPage); what the tenant is
	 * called and the addresses it gives out are read from the tenant info API and shown after it.
	 */
	interface Props {
		client: SettingsClient;
		info: TenantInfoClient;
		tenantId: string;
		/** Who is looking; the signed-in admin unless given (Storybook). */
		access?: AdminAccess;
	}

	let { client, info, tenantId, access }: Props = $props();
</script>

<SettingsPage page={TENANT_GENERAL} {client} target={{ level: 'tenant', tenantId }} {access}>
	{#snippet after()}
		<TenantInfoPanel client={info} {tenantId} />
	{/snippet}
</SettingsPage>
