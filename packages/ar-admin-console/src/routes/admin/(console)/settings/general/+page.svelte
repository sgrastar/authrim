<script lang="ts">
	import { httpSettings } from '$lib/api/settings';
	import { httpTenantInfo } from '$lib/api/tenant-info';
	import { tenantScope } from '$lib/auth/tenant-scope.svelte';
	import { t } from '$lib/i18n/i18n.svelte';
	import TenantGeneral from '$lib/pages/tenant-general/TenantGeneral.svelte';
</script>

<svelte:head>
	<title>{t('set.page.general')} — {t('app.brand')}</title>
</svelte:head>

{#if tenantScope.tenantId}
	{#key tenantScope.tenantId}
		<TenantGeneral client={httpSettings} info={httpTenantInfo} tenantId={tenantScope.tenantId} />
	{/key}
{/if}
