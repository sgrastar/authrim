<script lang="ts">
	import { untrack } from 'svelte';
	import { settingsLevel, teamAccess, widest, type AdminAccess } from '#lib/access/access.js';
	import { adminAccess } from '#lib/access/admin-access.svelte.js';
	import type { AdminTeamClient } from '#lib/api/admin-team.js';
	import type { SettingsClient } from '#lib/api/settings.js';
	import { t } from '#lib/i18n/i18n.svelte.js';
	import TeamSettings from '#lib/pages/settings/TeamSettings.svelte';
	import EmptyState from '#lib/ui/patterns/EmptyState.svelte';
	import PageHeader from '#lib/ui/patterns/PageHeader.svelte';
	import Tabs from '#lib/ui/patterns/Tabs.svelte';
	import Button from '#lib/ui/primitives/Button.svelte';
	import LeaveConfirm from '#lib/ui/save/LeaveConfirm.svelte';
	import Page from '#lib/ui/templates/Page.svelte';
	import AdminList from './AdminList.svelte';
	import InvitationList from './InvitationList.svelte';
	import type { TeamTab } from './team-model';

	/**
	 * Settings → Administrators: the tenant's administrators, the invitations sent to new ones,
	 * and how administrators sign in. Each tab is there only for an admin who can use it: the
	 * lists need the administrators' read permission, the sign-in settings their settings.
	 */
	interface Props {
		team: AdminTeamClient;
		settings: SettingsClient;
		tenantId: string;
		/** Where "Invite administrator" goes. */
		inviteHref: string;
		/** Who is looking; the signed-in admin unless given (Storybook). */
		access?: AdminAccess;
		/** The tab shown first (links, stories); an unavailable one falls back to the first. */
		initialTab?: TeamTab;
	}

	let { team, settings, tenantId, inviteHref, access, initialTab = 'admins' }: Props = $props();

	const who = $derived(access ?? adminAccess.current);
	const can = $derived(teamAccess(who));
	const signIn = $derived(
		widest([settingsLevel(who, 'session', 'tenant'), settingsLevel(who, 'security', 'tenant')])
	);

	const tabs = $derived([
		...(can.read
			? [
					{ id: 'admins', label: t('tm.tab.admins') },
					{ id: 'invitations', label: t('tm.tab.invitations') }
				]
			: []),
		...(signIn !== 'none' ? [{ id: 'signin', label: t('tm.tab.signin') }] : [])
	]);

	let tab = $state<string>(untrack(() => initialTab));
	// The sign-in settings tab: unsaved changes ask before another tab replaces them, and no tab
	// changes while they are being saved.
	let dirty = $state(false);
	let saving = $state(false);
	let leavingTo = $state<string | null>(null);

	function beforeChange(next: string): boolean {
		if (saving) return false;
		if (!dirty) return true;
		leavingTo = next;
		return false;
	}

	function leave() {
		if (leavingTo === null) return;
		dirty = false;
		tab = leavingTo;
		leavingTo = null;
	}
	$effect(() => {
		if (tabs.length > 0 && !tabs.some((item) => item.id === tab)) tab = tabs[0].id;
	});
</script>

<Page>
	<PageHeader title={t('set.page.team')} description={t('tm.page.desc')}>
		{#snippet actions()}
			{#if can.inviteForm}
				<Button variant="primary" icon="userPlus" href={inviteHref}>{t('tm.invite')}</Button>
			{/if}
		{/snippet}
	</PageHeader>

	{#if tabs.length === 0}
		<EmptyState icon="lock" title={t('access.none.title')} description={t('access.none.body')} />
	{:else}
		<Tabs
			label={t('set.page.team')}
			items={tabs}
			bind:value={tab}
			disabled={saving}
			onbeforechange={beforeChange}
		>
			{#snippet panel(id)}
				{#if id === 'admins'}
					<AdminList client={team} access={can} />
				{:else if id === 'invitations'}
					<InvitationList client={team} access={can} />
				{:else}
					<TeamSettings
						client={settings}
						{tenantId}
						access={who}
						framed={false}
						onstate={(state) => ({ dirty, saving } = state)}
					/>
				{/if}
			{/snippet}
		</Tabs>
	{/if}
</Page>

<LeaveConfirm open={leavingTo !== null} onleave={leave} onstay={() => (leavingTo = null)} />
