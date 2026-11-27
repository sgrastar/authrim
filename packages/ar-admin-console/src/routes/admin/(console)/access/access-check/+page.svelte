<script lang="ts">
	import { page } from '$app/state';
	import { authzAccess } from '#lib/access/access.js';
	import { adminAccess } from '#lib/access/admin-access.svelte.js';
	import { httpAccessCheck } from '#lib/api/access-check.js';
	import { httpAdminUsers } from '#lib/api/admin-users.js';
	import { httpEndUserGroups } from '#lib/api/end-user-groups.js';
	import { tenantScope } from '#lib/auth/tenant-scope.svelte.js';
	import { t } from '#lib/i18n/i18n.svelte.js';
	import AccessCheckPage from '#lib/pages/authz/AccessCheckPage.svelte';

	const subject = $derived(page.url.searchParams.get('user') ?? undefined);
</script>

<svelte:head>
	<title>{t('nav.access.accessCheck')} — {t('app.brand')}</title>
</svelte:head>

{#if tenantScope.tenantId}
	{#key tenantScope.tenantId}
		<AccessCheckPage
			client={httpAccessCheck(tenantScope.tenantId)}
			users={httpAdminUsers}
			groups={httpEndUserGroups(tenantScope.tenantId)}
			access={authzAccess(adminAccess.current)}
			subjectId={subject}
		/>
	{/key}
{/if}
