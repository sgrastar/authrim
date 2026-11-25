<script lang="ts">
	import { httpSystemLog } from '#lib/api/system-log.js';
	import { tenantScope } from '#lib/auth/tenant-scope.svelte.js';
	import { t } from '#lib/i18n/i18n.svelte.js';
	import SystemLog from '#lib/pages/monitoring/SystemLog.svelte';
</script>

<svelte:head>
	<title>{t('nav.mon.system')} — {t('app.brand')}</title>
</svelte:head>

{#if tenantScope.tenantId}
	{#key tenantScope.tenantId}
		<SystemLog client={httpSystemLog} />
	{/key}
{/if}
