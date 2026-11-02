<script lang="ts">
	import { httpSettings } from '#lib/api/settings.js';
	import { tenantScope } from '#lib/auth/tenant-scope.svelte.js';
	import { t } from '#lib/i18n/i18n.svelte.js';
	import EnterpriseSaml from '#lib/pages/authentication/EnterpriseSaml.svelte';
</script>

<svelte:head>
	<title>{t('set.page.enterprise')} — {t('app.brand')}</title>
</svelte:head>

{#if tenantScope.tenantId}
	{#key tenantScope.tenantId}
		<EnterpriseSaml client={httpSettings} tenantId={tenantScope.tenantId} />
	{/key}
{/if}
