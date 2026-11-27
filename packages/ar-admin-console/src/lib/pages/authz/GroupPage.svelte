<script lang="ts">
	import { untrack } from 'svelte';
	import type { AuthzAccess } from '#lib/access/access.js';
	import type { AdminUsersClient } from '#lib/api/admin-users.js';
	import { ApiError } from '#lib/api/api-error.js';
	import type { EndUserGroupDetail, EndUserGroupsClient } from '#lib/api/end-user-groups.js';
	import type { EndUserRolesClient } from '#lib/api/end-user-roles.js';
	import { t } from '#lib/i18n/i18n.svelte.js';
	import Callout from '#lib/ui/patterns/Callout.svelte';
	import Card from '#lib/ui/patterns/Card.svelte';
	import DangerZone from '#lib/ui/patterns/DangerZone.svelte';
	import DetailItem from '#lib/ui/patterns/DetailItem.svelte';
	import DetailList from '#lib/ui/patterns/DetailList.svelte';
	import EmptyState from '#lib/ui/patterns/EmptyState.svelte';
	import LoadingState from '#lib/ui/patterns/LoadingState.svelte';
	import PageHeader from '#lib/ui/patterns/PageHeader.svelte';
	import Tabs from '#lib/ui/patterns/Tabs.svelte';
	import BackLink from '#lib/ui/primitives/BackLink.svelte';
	import Badge from '#lib/ui/primitives/Badge.svelte';
	import Button from '#lib/ui/primitives/Button.svelte';
	import Link from '#lib/ui/primitives/Link.svelte';
	import Page from '#lib/ui/templates/Page.svelte';
	import DateTime from '#lib/ui/time/DateTime.svelte';
	import type { TimeZoneMode } from '#lib/ui/time/format-time.js';
	import { toast } from '#lib/ui/toast/toast.svelte.js';
	import { refusalText } from './authz-errors';
	import GroupEditDialog from './GroupEditDialog.svelte';
	import GroupHierarchyTab from './GroupHierarchyTab.svelte';
	import GroupMembersTab from './GroupMembersTab.svelte';
	import GroupRolesTab from './GroupRolesTab.svelte';
	import GroupRuleTab from './GroupRuleTab.svelte';
	import { KIND_LABEL } from './group-model';

	/**
	 * Users → Groups → one group: what it is (key, kind, parent, state), and in tabs who is in it
	 * (from every source), the roles it gives, where it sits among the other groups and, for a
	 * dynamic group, its rule. A group from the service-group catalog is renamed, switched off and
	 * deleted through its rule; a SCIM or provisioned group's members come from its source.
	 */
	interface Props {
		client: EndUserGroupsClient;
		roles: EndUserRolesClient;
		/** Finds users to add. */
		users: Pick<AdminUsersClient, 'list'>;
		groupId: string;
		access: AuthzAccess;
		listHref: string;
		groupHref: (groupId: string) => string;
		/** Opens a user's page. */
		onopenuser?: (userId: string) => void;
		/** Opens a role's page. */
		onopenrole?: (roleId: string) => void;
		ondeleted: () => void;
		/** The tab open first. */
		tab?: 'members' | 'roles' | 'tree' | 'rule';
		zone?: TimeZoneMode;
	}

	let {
		client,
		roles,
		users,
		groupId,
		access,
		listHref,
		groupHref,
		onopenuser,
		onopenrole,
		ondeleted,
		tab = 'members',
		zone
	}: Props = $props();

	let group = $state<EndUserGroupDetail | null>(null);
	let phase = $state<'loading' | 'ready' | 'notFound' | 'forbidden' | 'failed'>('loading');
	let current = $state(untrack(() => tab));
	let editing = $state(false);
	/**
	 * A rule save did not reach every shard. Kept here, not in the tab: reading the group again may
	 * fail and take the tabs away, and the admin must still learn that old memberships may grant.
	 */
	let ruleExpiryPending = $state(false);

	async function load(quiet = false) {
		if (!quiet) phase = 'loading';
		try {
			group = await client.get(groupId);
			phase = 'ready';
		} catch (failure) {
			if (quiet) toast.error(t('grp.d.loadFailed'));
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

	const parent = $derived(group?.parent_chain[0] ?? null);
	const tabs = $derived([
		{ id: 'members', label: t('grp.tab.members'), count: group?.member_count },
		{ id: 'roles', label: t('grp.tab.roles'), count: group?.roles.length },
		{ id: 'tree', label: t('grp.tab.tree') },
		// The rule is read from the service-group catalog, with the users' read permission.
		...(group?.managed && access.rulesRead ? [{ id: 'rule', label: t('grp.tab.rule') }] : [])
	]);
	const canEdit = $derived(access.groupsWrite && group !== null && !group.managed);
	const canDelete = $derived(
		group !== null && (group.managed ? access.rulesWrite : access.groupsWrite)
	);

	async function remove() {
		if (!group) return;
		const name = group.display_name;
		try {
			if (group.managed) {
				const catalog = await client.catalog();
				await client.removeDynamic(group.id, catalog.revision);
			} else {
				await client.remove(group.id);
			}
		} catch (failure) {
			toast.error(refusalText(failure, t));
			return;
		}
		toast.success(t('grp.toast.deleted', { name }));
		ondeleted();
	}
</script>

<Page>
	<PageHeader title={group?.display_name ?? t('nav.users.groups')}>
		{#snippet back()}
			<BackLink href={listHref}>{t('grp.d.back')}</BackLink>
		{/snippet}
		{#snippet badges()}
			{#if group}
				<Badge tone={group.kind === 'dynamic' ? 'info' : 'neutral'}
					>{t(KIND_LABEL[group.kind])}</Badge
				>
				{#if group.lifecycle_state === 'inactive'}
					<Badge dot>{t('grp.state.inactive')}</Badge>
				{/if}
			{/if}
		{/snippet}
		{#snippet actions()}
			{#if canEdit}
				<Button icon="pencil" onclick={() => (editing = true)}>{t('grp.d.edit')}</Button>
			{/if}
		{/snippet}
	</PageHeader>

	{#if ruleExpiryPending}
		<Callout tone="warning" live>{t('grp.rule.savedExpiryPending')}</Callout>
	{/if}

	{#if phase === 'loading'}
		<LoadingState label={t('common.loading')} />
	{:else if phase === 'notFound'}
		<EmptyState icon="users" title={t('grp.d.notFound')}>
			{#snippet action()}
				<Button href={listHref}>{t('grp.d.back')}</Button>
			{/snippet}
		</EmptyState>
	{:else if phase === 'forbidden'}
		<EmptyState icon="lock" title={t('grp.list.noAccess')} />
	{:else if phase === 'failed' || !group}
		<EmptyState icon="warningCircle" title={t('grp.d.loadFailed')}>
			{#snippet action()}
				<Button size="sm" onclick={() => load()}>{t('common.retry')}</Button>
			{/snippet}
		</EmptyState>
	{:else}
		{#if group.managed}
			<Callout icon="info">{t('grp.d.managedNote')}</Callout>
		{:else if group.kind === 'scim' || group.kind === 'provisioned'}
			<Callout icon="info">{t('grp.d.sourcedNote')}</Callout>
		{/if}
		<Card title={t('grp.d.profile')}>
			<DetailList columns={2} ruled>
				<DetailItem label={t('grp.d.key')}><code>{group.group_key}</code></DetailItem>
				<DetailItem label={t('grp.list.col.kind')}>{t(KIND_LABEL[group.kind])}</DetailItem>
				<DetailItem label={t('grp.new.description')}>
					{group.description ?? t('grp.d.noDescription')}
				</DetailItem>
				<DetailItem label={t('grp.new.parent')}>
					{#if parent}
						<Link href={groupHref(parent.id)}>{parent.display_name}</Link>
					{:else}
						{t('grp.new.noParent')}
					{/if}
				</DetailItem>
				{#if group.external_id}
					<DetailItem label={t('grp.d.externalId')}><code>{group.external_id}</code></DetailItem>
				{/if}
				{#if group.created_at}
					<DetailItem label={t('grp.d.created')}><DateTime value={group.created_at} /></DetailItem>
				{/if}
			</DetailList>
		</Card>

		<Tabs label={group.display_name} items={tabs} bind:value={current}>
			{#snippet panel(id)}
				<div class="panel">
					{#if !group}
						<!-- The group is read again: its tabs wait for it. -->
					{:else if id === 'members'}
						<GroupMembersTab
							{client}
							{users}
							{group}
							{access}
							{onopenuser}
							onchanged={() => void load(true)}
						/>
					{:else if id === 'roles'}
						<GroupRolesTab
							{client}
							{roles}
							{group}
							{access}
							{onopenrole}
							{zone}
							onchanged={() => load(true)}
						/>
					{:else if id === 'tree'}
						<GroupHierarchyTab {client} {group} {groupHref} />
					{:else if id === 'rule'}
						<GroupRuleTab
							{client}
							{group}
							{access}
							onsaved={async ({ expiryPending }) => {
								ruleExpiryPending = expiryPending;
								await load(true);
							}}
						/>
					{/if}
				</div>
			{/snippet}
		</Tabs>

		{#if canDelete}
			<DangerZone
				title={t('grp.d.delete.title')}
				description={group.managed ? t('grp.d.delete.descManaged') : t('grp.d.delete.desc')}
				actionLabel={t('grp.d.delete.action')}
				confirmTitle={t('grp.d.delete.confirmTitle', { name: group.display_name })}
				confirmBody={t('grp.d.delete.confirmBody', { count: group.member_count })}
				onconfirm={remove}
			/>
		{/if}
	{/if}
</Page>

{#if group && canEdit}
	<GroupEditDialog
		{client}
		{group}
		open={editing}
		oncancel={() => (editing = false)}
		onsaved={() => {
			editing = false;
			void load(true);
		}}
	/>
{/if}

<style>
	.panel {
		display: grid;
		gap: var(--space-section, 24px);
		padding-top: var(--space-related);
	}
</style>
