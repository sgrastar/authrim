<script lang="ts">
	import { goto } from '$app/navigation';
	import { page } from '$app/state';
	import { httpAdminTeam } from '#lib/api/admin-team.js';
	import { httpSettings } from '#lib/api/settings.js';
	import { tenantScope } from '#lib/auth/tenant-scope.svelte.js';
	import { t } from '#lib/i18n/i18n.svelte.js';
	import TeamPage from '#lib/pages/team/TeamPage.svelte';
	import { teamTabOf } from '#lib/pages/team/team-model.js';
</script>

<svelte:head>
	<title>{t('set.page.team')} — {t('app.brand')}</title>
</svelte:head>

{#if tenantScope.tenantId}
	{#key tenantScope.tenantId}
		<TeamPage
			team={httpAdminTeam(tenantScope.tenantId)}
			settings={httpSettings}
			tenantId={tenantScope.tenantId}
			inviteHref="/admin/settings/team/invite"
			onopen={(adminId) => void goto(`/admin/settings/team/${encodeURIComponent(adminId)}`)}
			initialTab={teamTabOf(page.url.searchParams.get('tab'))}
		/>
	{/key}
{/if}
