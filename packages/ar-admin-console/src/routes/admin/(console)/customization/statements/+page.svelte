<script lang="ts">
	import { goto } from '$app/navigation';
	import { hasPermission } from '#lib/access/access.js';
	import { adminAccess } from '#lib/access/admin-access.svelte.js';
	import { httpConsentStatements } from '#lib/api/consent-statements.js';
	import { tenantScope } from '#lib/auth/tenant-scope.svelte.js';
	import { t } from '#lib/i18n/i18n.svelte.js';
	import StatementList from '#lib/pages/customization/statements/StatementList.svelte';

	const BASE = '/admin/customization/statements';
	const canWrite = $derived(hasPermission(adminAccess.current, 'admin:settings:write'));
	const hrefOf = (id: string) => `${BASE}/${encodeURIComponent(id)}`;
</script>

<svelte:head>
	<title>{t('nav.custom.statements')} — {t('app.brand')}</title>
</svelte:head>

{#key tenantScope.tenantId}
	<StatementList
		client={httpConsentStatements}
		{canWrite}
		{hrefOf}
		onopen={(id) => goto(hrefOf(id))}
	/>
{/key}
