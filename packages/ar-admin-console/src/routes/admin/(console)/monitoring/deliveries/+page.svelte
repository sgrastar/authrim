<script lang="ts">
	import { httpEmailDeliveries } from '#lib/api/email-deliveries.js';
	import { tenantScope } from '#lib/auth/tenant-scope.svelte.js';
	import { t } from '#lib/i18n/i18n.svelte.js';
	import EmailDeliveries from '#lib/pages/monitoring/EmailDeliveries.svelte';
</script>

<svelte:head>
	<title>{t('nav.mon.deliveries')} — {t('app.brand')}</title>
</svelte:head>

{#if tenantScope.tenantId}
	{#key tenantScope.tenantId}
		<EmailDeliveries client={httpEmailDeliveries} />
	{/key}
{/if}
