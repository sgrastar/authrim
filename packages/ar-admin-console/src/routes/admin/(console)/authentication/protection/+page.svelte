<script lang="ts">
	import { httpSettings } from '#lib/api/settings.js';
	import { tenantScope } from '#lib/auth/tenant-scope.svelte.js';
	import { t } from '#lib/i18n/i18n.svelte.js';
	import Protection from '#lib/pages/authentication/Protection.svelte';
</script>

<svelte:head>
	<title>{t('set.page.protection')} — {t('app.brand')}</title>
</svelte:head>

{#if tenantScope.tenantId}
	{#key tenantScope.tenantId}
		<Protection client={httpSettings} tenantId={tenantScope.tenantId} />
	{/key}
{/if}
