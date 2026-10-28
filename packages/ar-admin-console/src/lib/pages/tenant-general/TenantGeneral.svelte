<script lang="ts">
	import type { TenantInfoClient } from '$lib/api/tenant-info';
	import { t } from '$lib/i18n/i18n.svelte';
	import PageHeader from '$lib/ui/patterns/PageHeader.svelte';
	import Page from '$lib/ui/templates/Page.svelte';
	import TenantInfoPanel from './TenantInfoPanel.svelte';

	/**
	 * Settings → General: what the tenant is called and the addresses it gives out, read from the
	 * tenant info API. Nothing is set here (the logo is a setting of Customization → Branding).
	 */
	interface Props {
		info: TenantInfoClient;
		tenantId: string;
	}

	let { info, tenantId }: Props = $props();
</script>

<Page>
	<PageHeader title={t('tg.page')} description={t('tg.page.desc')} />
	<TenantInfoPanel client={info} {tenantId} />
</Page>
