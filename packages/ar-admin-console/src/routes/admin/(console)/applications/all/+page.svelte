<script lang="ts">
	import { tenantScope } from '#lib/auth/tenant-scope.svelte.js';
	import { t } from '#lib/i18n/i18n.svelte.js';
	import AccountServiceFlowsPage from '#lib/pages/service-flows/AccountServiceFlowsPage.svelte';
</script>

<svelte:head>
	<title>{t('nav.apps.all')} — {t('app.brand')}</title>
</svelte:head>

{#key tenantScope.tenantId}
	<AccountServiceFlowsPage />
{/key}
