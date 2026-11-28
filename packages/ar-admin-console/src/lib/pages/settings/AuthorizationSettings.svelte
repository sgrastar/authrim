<script lang="ts">
	import { hasPermission, isCapabilityDisabled, type AdminAccess } from '#lib/access/access.js';
	import { adminAccess } from '#lib/access/admin-access.svelte.js';
	import type { CheckApiKeysClient } from '#lib/api/check-api-keys.js';
	import type { SettingsClient } from '#lib/api/settings.js';
	import { t } from '#lib/i18n/i18n.svelte.js';
	import { AUTHORIZATION } from '#lib/settings/placement.js';
	import SettingsPage from '#lib/settings/SettingsPage.svelte';
	import PageHeader from '#lib/ui/patterns/PageHeader.svelte';
	import Page from '#lib/ui/templates/Page.svelte';
	import CheckApiKeysCard from './CheckApiKeysCard.svelte';

	/**
	 * Settings → Authorization: the settings of the end-user authorization (`AUTHORIZATION`:
	 * ABAC and ReBAC, the Check API, dynamic group freshness, RBAC claims in tokens), and the
	 * Check API keys from their own API, for admins who may read them (and make or revoke them
	 * with `admin:security:write`; new keys also need the platform's machine credentials on).
	 */
	interface Props {
		client: SettingsClient;
		keys: CheckApiKeysClient;
		tenantId: string;
		/** Who is looking; the signed-in admin unless given (Storybook). */
		access?: AdminAccess;
	}

	let { client, keys, tenantId, access }: Props = $props();
	const who = $derived(access ?? adminAccess.current);
	const canWrite = $derived(hasPermission(who, 'admin:security:write'));
	const canList = $derived(hasPermission(who, 'admin:security:read'));
	// The platform's `machine_credentials` switch stops new keys, not revoking (the API exempts it).
	const capabilityOff = $derived(isCapabilityDisabled(who, 'machine_credentials'));
</script>

<Page>
	<PageHeader title={t('set.page.authorization')} description={t('set.page.authorization.desc')} />
	<SettingsPage
		page={AUTHORIZATION}
		{client}
		target={{ level: 'tenant', tenantId }}
		{access}
		framed={false}
	/>
	{#if canList || canWrite}
		<!-- Listing needs read; making a key needs write and the capability; revoking only write. -->
		<CheckApiKeysCard
			client={keys}
			{tenantId}
			{canList}
			canRevoke={canWrite}
			canCreate={canWrite && !capabilityOff}
			capabilityOff={canWrite && capabilityOff}
		/>
	{/if}
</Page>
