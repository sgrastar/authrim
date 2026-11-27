<script lang="ts">
	import { httpCheckApiKeys } from '#lib/api/check-api-keys.js';
	import { httpSettings } from '#lib/api/settings.js';
	import { tenantScope } from '#lib/auth/tenant-scope.svelte.js';
	import { t } from '#lib/i18n/i18n.svelte.js';
	import AuthorizationSettings from '#lib/pages/settings/AuthorizationSettings.svelte';
</script>

<svelte:head>
	<title>{t('set.page.authorization')} — {t('app.brand')}</title>
</svelte:head>

{#if tenantScope.tenantId}
	{#key tenantScope.tenantId}
		<AuthorizationSettings
			client={httpSettings}
			keys={httpCheckApiKeys(tenantScope.tenantId)}
			tenantId={tenantScope.tenantId}
		/>
	{/key}
{/if}
