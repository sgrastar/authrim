<script lang="ts">
	import { untrack } from 'svelte';
	import type { TeamAccess } from '#lib/access/access.js';
	import type { AdminGroupDetail, AdminGroupsClient } from '#lib/api/admin-groups.js';
	import { teamErrorCode, type AdminTeamClient } from '#lib/api/admin-team.js';
	import { ApiError } from '#lib/api/api-error.js';
	import { t } from '#lib/i18n/i18n.svelte.js';
	import Card from '#lib/ui/patterns/Card.svelte';
	import DangerZone from '#lib/ui/patterns/DangerZone.svelte';
	import DetailItem from '#lib/ui/patterns/DetailItem.svelte';
	import DetailList from '#lib/ui/patterns/DetailList.svelte';
	import EmptyState from '#lib/ui/patterns/EmptyState.svelte';
	import FormDialog from '#lib/ui/patterns/FormDialog.svelte';
	import LoadingState from '#lib/ui/patterns/LoadingState.svelte';
	import PageHeader from '#lib/ui/patterns/PageHeader.svelte';
	import BackLink from '#lib/ui/primitives/BackLink.svelte';
	import Button from '#lib/ui/primitives/Button.svelte';
	import TextArea from '#lib/ui/primitives/TextArea.svelte';
	import TextField from '#lib/ui/primitives/TextField.svelte';
	import Page from '#lib/ui/templates/Page.svelte';
	import type { TimeZoneMode } from '#lib/ui/time/format-time.js';
	import { toast } from '#lib/ui/toast/toast.svelte.js';
	import GroupGrants from './GroupGrants.svelte';
	import GroupMembers from './GroupMembers.svelte';
	import { teamErrorKey } from './team-errors';

	/**
	 * Settings → Administrator groups → one group: its name and description (editable; the key is
	 * set once), its members, the roles it gives them, and deleting it.
	 */
	interface Props {
		groups: AdminGroupsClient;
		/** Finds administrators to add and roles to give. */
		team: AdminTeamClient;
		groupId: string;
		access: TeamAccess;
		listHref: string;
		/** Opens an administrator's page. */
		onopenadmin?: (adminId: string) => void;
		ondeleted: () => void;
		/** Override the zone role ends are typed in (tests; normally the admin's choice). */
		zone?: TimeZoneMode;
	}

	let { groups, team, groupId, access, listHref, onopenadmin, ondeleted, zone }: Props = $props();

	let group = $state<AdminGroupDetail | null>(null);
	let phase = $state<'loading' | 'ready' | 'notFound' | 'forbidden' | 'failed'>('loading');
	let editing = $state(false);
	let busy = $state(false);
	let name = $state('');
	let description = $state('');
	let error = $state('');

	async function load(quiet = false) {
		if (!quiet) phase = 'loading';
		try {
			group = await groups.get(groupId);
			phase = 'ready';
		} catch (failure) {
			// What is on screen may be out of date: it goes, and the page offers to load again.
			if (quiet) toast.error(t('tg.d.loadFailed'));
			group = null;
			phase =
				failure instanceof ApiError && failure.status === 404
					? 'notFound'
					: failure instanceof ApiError && failure.status === 403
						? 'forbidden'
						: 'failed';
		}
	}

	$effect(() => {
		void groupId;
		untrack(() => void load());
	});

	function openEdit() {
		if (!group) return;
		name = group.display_name;
		description = group.description ?? '';
		error = '';
		editing = true;
	}

	async function save() {
		if (!group) return;
		if (!name.trim()) {
			error = t('tg.new.nameRequired');
			return;
		}
		busy = true;
		error = '';
		try {
			await groups.update(group.id, { display_name: name, description });
			editing = false;
			toast.success(t('tg.toast.saved'));
			await load(true);
		} catch (failure) {
			error = t(teamErrorKey(failure));
		} finally {
			busy = false;
		}
	}

	async function remove() {
		if (!group) return;
		const label = group.display_name;
		try {
			await groups.remove(group.id);
		} catch (failure) {
			toast.error(t(teamErrorKey(failure)));
			// Changed meanwhile: show what it is now, so a second try is decided on that.
			if (teamErrorCode(failure) === 'admin_group_changed') await load(true);
			return;
		}
		toast.success(t('tg.toast.deleted', { name: label }));
		ondeleted();
	}
</script>

<Page>
	<PageHeader title={group?.display_name ?? t('nav.set.teamGroups')}>
		{#snippet back()}
			<BackLink href={listHref}>{t('tg.d.back')}</BackLink>
		{/snippet}
	</PageHeader>

	{#if phase === 'loading'}
		<LoadingState label={t('common.loading')} />
	{:else if phase === 'notFound'}
		<EmptyState icon="users" title={t('tg.d.notFound')} />
	{:else if phase === 'forbidden'}
		<EmptyState icon="lock" title={t('tg.list.noAccess')} />
	{:else if phase === 'failed' || !group}
		<EmptyState icon="warningCircle" title={t('tg.d.loadFailed')}>
			{#snippet action()}
				<Button size="sm" onclick={() => load()}>{t('common.retry')}</Button>
			{/snippet}
		</EmptyState>
	{:else}
		<Card title={t('tg.d.profile')}>
			{#snippet actions()}
				{#if access.groupsEdit}
					<Button size="sm" icon="pencil" onclick={openEdit}>{t('tg.d.edit')}</Button>
				{/if}
			{/snippet}
			<DetailList columns={2} ruled>
				<DetailItem label={t('tg.new.name')}>{group.display_name}</DetailItem>
				<DetailItem label={t('tg.d.key')}>{group.group_key}</DetailItem>
				<DetailItem label={t('tg.d.description')}>
					{group.description ?? t('tg.d.noDescription')}
				</DetailItem>
			</DetailList>
		</Card>

		<GroupMembers {groups} {team} {group} {access} {onopenadmin} onchanged={() => load(true)} />

		<GroupGrants {groups} {team} {group} {access} {zone} onchanged={() => load(true)} />

		{#if access.groupsEdit}
			<DangerZone
				title={t('tg.d.delete.title')}
				description={t('tg.d.delete.desc')}
				actionLabel={t('tg.d.delete.action')}
				confirmTitle={t('tg.d.delete.confirmTitle', { name: group.display_name })}
				confirmBody={t('tg.d.delete.confirmBody', { count: group.members.length })}
				onconfirm={remove}
			/>
		{/if}
	{/if}
</Page>

<FormDialog
	open={editing}
	title={t('tg.d.edit.title')}
	submitLabel={t('tg.d.edit.save')}
	{busy}
	{error}
	onsubmit={save}
	oncancel={() => (editing = false)}
>
	<TextField label={t('tg.new.name')} required maxlength={100} bind:value={name} />
	<TextArea label={t('tg.d.description')} maxlength={500} bind:value={description} />
</FormDialog>
