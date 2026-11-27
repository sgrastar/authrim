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
	 * Check API keys from their own API, for admins who may read them.
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
	{#if hasPermission(who, 'admin:security:read')}
		<!-- Revoking is a machine-credential change: refused while the platform has them off. -->
		<CheckApiKeysCard
			client={keys}
			canRevoke={hasPermission(who, 'admin:security:write') &&
				!isCapabilityDisabled(who, 'machine_credentials')}
		/>
	{/if}
</Page>
