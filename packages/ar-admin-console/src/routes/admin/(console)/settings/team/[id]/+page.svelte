<script lang="ts">
	import { goto } from '$app/navigation';
	import { page } from '$app/state';
	import { teamAccess } from '#lib/access/access.js';
	import { adminAccess } from '#lib/access/admin-access.svelte.js';
	import { httpAdminTeam } from '#lib/api/admin-team.js';
	import { tenantScope } from '#lib/auth/tenant-scope.svelte.js';
	import { t } from '#lib/i18n/i18n.svelte.js';
	import AdminDetailPage from '#lib/pages/team/AdminDetailPage.svelte';

	const BASE = '/admin/settings/team';
	const id = $derived(page.params.id ?? '');
</script>

<svelte:head>
	<title>{t('set.page.team')} — {t('app.brand')}</title>
</svelte:head>

{#if tenantScope.tenantId}
	{#key `${tenantScope.tenantId}:${id}`}
		<AdminDetailPage
			client={httpAdminTeam(tenantScope.tenantId)}
			adminId={id}
			access={teamAccess(adminAccess.current)}
			tenantId={tenantScope.tenantId}
			listHref={BASE}
			ondeleted={() => void goto(BASE)}
			groupHref={(groupId) => `/admin/settings/team-groups/${encodeURIComponent(groupId)}`}
		/>
	{/key}
{/if}
