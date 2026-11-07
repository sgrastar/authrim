<script lang="ts">
	import { goto } from '$app/navigation';
	import { teamAccess } from '#lib/access/access.js';
	import { adminAccess } from '#lib/access/admin-access.svelte.js';
	import { httpAdminTeam } from '#lib/api/admin-team.js';
	import { tenantScope } from '#lib/auth/tenant-scope.svelte.js';
	import { t } from '#lib/i18n/i18n.svelte.js';
	import InvitePage from '#lib/pages/team/InvitePage.svelte';

	const BASE = '/admin/settings/team';
</script>

<svelte:head>
	<title>{t('tm.new.title')} — {t('app.brand')}</title>
</svelte:head>

{#if tenantScope.tenantId}
	{#key tenantScope.tenantId}
		<InvitePage
			client={httpAdminTeam(tenantScope.tenantId)}
			access={teamAccess(adminAccess.current)}
			tenantId={tenantScope.tenantId}
			listHref={BASE}
			onsent={() => void goto(`${BASE}?tab=invitations`)}
		/>
	{/key}
{/if}
