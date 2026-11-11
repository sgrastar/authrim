<script lang="ts">
	import { goto } from '$app/navigation';
	import { settingsLevel } from '#lib/access/access.js';
	import { adminAccess } from '#lib/access/admin-access.svelte.js';
	import { httpSessionProfiles } from '#lib/api/session-profiles.js';
	import { tenantScope } from '#lib/auth/tenant-scope.svelte.js';
	import { t } from '#lib/i18n/i18n.svelte.js';
	import EmptyState from '#lib/ui/patterns/EmptyState.svelte';
	import SessionProfileList from '#lib/pages/authentication/SessionProfileList.svelte';

	const BASE = '/admin/authentication/session-profiles';
	// As the Admin API decides it: by the session settings' level (SSO is held with them).
	const level = $derived(settingsLevel(adminAccess.current, 'session', 'tenant'));
	const canWrite = $derived(level === 'edit');
	const hrefOf = (id: string) => `${BASE}/${encodeURIComponent(id)}`;
</script>

<svelte:head><title>{t('sp.list.title')} — {t('app.brand')}</title></svelte:head>

{#if level === 'none'}
	<EmptyState icon="lock" title={t('access.none.title')} />
{:else}
	{#key tenantScope.tenantId}
		<SessionProfileList
			client={httpSessionProfiles}
			{canWrite}
			{hrefOf}
			onopen={(id) => goto(hrefOf(id))}
		/>
	{/key}
{/if}
