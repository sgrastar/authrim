<script lang="ts">
	import { httpLogPlatform } from '#lib/api/log-platform.js';
	import { tenantScope } from '#lib/auth/tenant-scope.svelte.js';
	import { t } from '#lib/i18n/i18n.svelte.js';
	import LogPlatformStatus from '#lib/pages/monitoring/LogPlatformStatus.svelte';
</script>

<svelte:head>
	<title>{t('nav.mon.logPlatform')} — {t('app.brand')}</title>
</svelte:head>

{#if tenantScope.tenantId}
	{#key tenantScope.tenantId}
		<LogPlatformStatus client={httpLogPlatform} />
	{/key}
{/if}
