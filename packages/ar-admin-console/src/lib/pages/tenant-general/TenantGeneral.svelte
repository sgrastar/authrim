<script lang="ts">
	import type { AdminAccess } from '#lib/access/access.js';
	import { adminAccess } from '#lib/access/admin-access.svelte.js';
	import type { SettingsClient } from '#lib/api/settings.js';
	import type { TenantInfoClient } from '#lib/api/tenant-info.js';
	import { t } from '#lib/i18n/i18n.svelte.js';
	import { GENERAL } from '#lib/settings/placement.js';
	import SettingsPage from '#lib/settings/SettingsPage.svelte';
	import PageHeader from '#lib/ui/patterns/PageHeader.svelte';
	import Page from '#lib/ui/templates/Page.svelte';
	import TenantInfoPanel from './TenantInfoPanel.svelte';

	/**
	 * Settings → General: what the tenant is called and the addresses it gives out, read from the
	 * tenant info API. Nothing of the tenant is set here (the logo is a setting of Customization →
	 * Branding). Given `settings`, platform admins also get the platform's environment banner
	 * settings below (`GENERAL`); other admins see none of it.
	 */
	interface Props {
		info: TenantInfoClient;
		tenantId: string;
		settings?: SettingsClient;
		/** Who is looking; the signed-in admin unless given (Storybook). */
		access?: AdminAccess;
	}

	let { info, tenantId, settings, access }: Props = $props();
	const who = $derived(access ?? adminAccess.current);
</script>

<Page>
	<PageHeader title={t('tg.page')} description={t('tg.page.desc')} />
	<TenantInfoPanel client={info} {tenantId} />
	{#if settings && who.platform}
		<SettingsPage
			page={GENERAL}
			client={settings}
			target={{ level: 'tenant', tenantId }}
			{access}
			framed={false}
		/>
	{/if}
</Page>
