<script lang="ts">
	import { goto } from '$app/navigation';
	import { page } from '$app/state';
	import { hasPermission } from '#lib/access/access.js';
	import { adminAccess } from '#lib/access/admin-access.svelte.js';
	import { httpConsentStatements } from '#lib/api/consent-statements.js';
	import { tenantScope } from '#lib/auth/tenant-scope.svelte.js';
	import { t } from '#lib/i18n/i18n.svelte.js';
	import StatementEditorPage from '#lib/pages/customization/statements/StatementEditorPage.svelte';

	const BASE = '/admin/customization/statements';
	const id = $derived(page.params.id ?? '');
	const canWrite = $derived(hasPermission(adminAccess.current, 'admin:settings:write'));
</script>

<svelte:head>
	<title>{t('nav.custom.statements')} — {t('app.brand')}</title>
</svelte:head>

{#key tenantScope.tenantId}
	<StatementEditorPage
		client={httpConsentStatements}
		{id}
		{canWrite}
		listHref={BASE}
		ondeleted={() => void goto(BASE)}
	/>
{/key}
