<script lang="ts">
	import { goto } from '$app/navigation';
	import { page } from '$app/state';
	import { httpAdminUsers } from '#lib/api/admin-users.js';
	import { tenantScope } from '#lib/auth/tenant-scope.svelte.js';
	import { t } from '#lib/i18n/i18n.svelte.js';
	import UserDetailPage from '#lib/pages/users/UserDetailPage.svelte';

	const LIST = '/admin/users/all';
	const id = $derived(page.params.id ?? '');
</script>

<svelte:head>
	<title>{t('nav.users.all')} — {t('app.brand')}</title>
</svelte:head>

{#if tenantScope.tenantId}
	{#key `${tenantScope.tenantId}:${id}`}
		<UserDetailPage
			client={httpAdminUsers}
			userId={id}
			listHref={LIST}
			ondeleted={() => void goto(LIST)}
			onopenaudit={(userId) =>
				void goto(`/admin/monitoring/audit?user=${encodeURIComponent(userId)}`)}
		/>
	{/key}
{/if}
