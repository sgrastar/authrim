<script lang="ts">
	import { httpLiteMode } from '#lib/api/login-ui-lite-mode.js';
	import { httpSettings } from '#lib/api/settings.js';
	import { tenantScope } from '#lib/auth/tenant-scope.svelte.js';
	import { t } from '#lib/i18n/i18n.svelte.js';
	import LoginUiPage from '#lib/pages/customization/LoginUiPage.svelte';
</script>

<svelte:head>
	<title>{t('lu.page')} — {t('app.brand')}</title>
</svelte:head>

{#if tenantScope.tenantId}
	{#key tenantScope.tenantId}
		<LoginUiPage client={httpSettings} lite={httpLiteMode} tenantId={tenantScope.tenantId} />
	{/key}
{/if}
