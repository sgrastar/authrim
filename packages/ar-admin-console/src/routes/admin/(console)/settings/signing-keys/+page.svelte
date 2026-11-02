<script lang="ts">
	import { httpSettings } from '#lib/api/settings.js';
	import { tenantScope } from '#lib/auth/tenant-scope.svelte.js';
	import { t } from '#lib/i18n/i18n.svelte.js';
	import SigningKeys from '#lib/pages/settings/SigningKeys.svelte';
</script>

<svelte:head>
	<title>{t('set.page.signingKeys')} — {t('app.brand')}</title>
</svelte:head>

{#if tenantScope.tenantId}
	{#key tenantScope.tenantId}
		<SigningKeys client={httpSettings} tenantId={tenantScope.tenantId} />
	{/key}
{/if}
