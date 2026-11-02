<script lang="ts">
	import { httpCompliance } from '#lib/api/compliance.js';
	import { tenantScope } from '#lib/auth/tenant-scope.svelte.js';
	import { t } from '#lib/i18n/i18n.svelte.js';
	import ComplianceSettings from '#lib/pages/settings/compliance/ComplianceSettings.svelte';
</script>

<svelte:head>
	<title>{t('cmp.page')} — {t('app.brand')}</title>
</svelte:head>

{#if tenantScope.tenantId}
	{#key tenantScope.tenantId}
		<ComplianceSettings client={httpCompliance} tenantId={tenantScope.tenantId} />
	{/key}
{/if}
