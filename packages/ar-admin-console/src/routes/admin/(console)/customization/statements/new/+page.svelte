<script lang="ts">
	import { goto } from '$app/navigation';
	import { hasPermission } from '#lib/access/access.js';
	import { adminAccess } from '#lib/access/admin-access.svelte.js';
	import { httpConsentStatements } from '#lib/api/consent-statements.js';
	import { tenantScope } from '#lib/auth/tenant-scope.svelte.js';
	import { t } from '#lib/i18n/i18n.svelte.js';
	import StatementCreatePage from '#lib/pages/customization/statements/StatementCreatePage.svelte';

	const BASE = '/admin/customization/statements';
	const canWrite = $derived(hasPermission(adminAccess.current, 'admin:settings:write'));
</script>

<svelte:head>
	<title>{t('cs.list.create')} — {t('app.brand')}</title>
</svelte:head>

{#key tenantScope.tenantId}
	<StatementCreatePage
		client={httpConsentStatements}
		{canWrite}
		listHref={BASE}
		oncreated={(id) => goto(`${BASE}/${encodeURIComponent(id)}`, { replaceState: true })}
	/>
{/key}
