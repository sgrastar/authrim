<script lang="ts">
	import { httpAdminAudit } from '#lib/api/admin-audit.js';
	import { tenantScope } from '#lib/auth/tenant-scope.svelte.js';
	import { t } from '#lib/i18n/i18n.svelte.js';
	import AdminActivity from '#lib/pages/monitoring/AdminActivity.svelte';
</script>

<svelte:head>
	<title>{t('nav.mon.adminActivity')} — {t('app.brand')}</title>
</svelte:head>

{#if tenantScope.tenantId}
	{#key tenantScope.tenantId}
		<AdminActivity client={httpAdminAudit} />
	{/key}
{/if}
