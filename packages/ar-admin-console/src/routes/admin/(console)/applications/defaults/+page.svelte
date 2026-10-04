<script lang="ts">
	import { httpSettings } from '$lib/api/settings';
	import { tenantScope } from '$lib/auth/tenant-scope.svelte';
	import { t } from '$lib/i18n/i18n.svelte';
	import AppDefaults from '$lib/pages/settings/AppDefaults.svelte';
</script>

<svelte:head>
	<title>{t('set.page.appDefaults')} — {t('app.brand')}</title>
</svelte:head>

{#if tenantScope.tenantId}
	{#key tenantScope.tenantId}
		<AppDefaults client={httpSettings} tenantId={tenantScope.tenantId} />
	{/key}
{/if}
