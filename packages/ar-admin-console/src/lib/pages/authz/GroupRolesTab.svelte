<script lang="ts">
	import { untrack } from 'svelte';
	import type { AuthzAccess } from '#lib/access/access.js';
	import type {
		EndUserGroupDetail,
		EndUserGroupsClient,
		GroupRoleGrant,
		GroupRoleInput
	} from '#lib/api/end-user-groups.js';
	import type { EndUserRole, EndUserRolesClient } from '#lib/api/end-user-roles.js';
	import { t } from '#lib/i18n/i18n.svelte.js';
	import Card from '#lib/ui/patterns/Card.svelte';
	import CellText from '#lib/ui/patterns/CellText.svelte';
	import ConfirmDialog from '#lib/ui/patterns/ConfirmDialog.svelte';
	import DataTable from '#lib/ui/patterns/DataTable.svelte';
	import EmptyState from '#lib/ui/patterns/EmptyState.svelte';
	import ActionMenu from '#lib/ui/primitives/ActionMenu.svelte';
	import Badge from '#lib/ui/primitives/Badge.svelte';
	import Button from '#lib/ui/primitives/Button.svelte';
	import DateTime from '#lib/ui/time/DateTime.svelte';
	import type { TimeZoneMode } from '#lib/ui/time/format-time.js';
	import { toast } from '#lib/ui/toast/toast.svelte.js';
	import { refusalText } from './authz-errors';
	import { SCOPE_LABEL, scopeText } from './group-model';
	import { GroupNames } from './group-names.svelte';
	import RoleGrantDialog from './RoleGrantDialog.svelte';
	import { groupSearch } from './user-picker';

	/**
	 * The roles a group gives everyone in it (and in the groups below it), each with where it
	 * holds and when it ends. Giving and taking one away is held to the admin's grant ceiling;
	 * the parents' roles are listed on their own pages.
	 */
	interface Props {
		client: EndUserGroupsClient;
		roles: EndUserRolesClient;
		group: EndUserGroupDetail;
		access: AuthzAccess;
		onchanged: () => Promise<void>;
		/** Opens a role's page. */
		onopenrole?: (roleId: string) => void;
		zone?: TimeZoneMode;
	}

	let { client, roles, group, access, onchanged, onopenrole, zone }: Props = $props();

	let granting = $state(false);
	let choices = $state<EndUserRole[] | null>(null);
	let removing = $state<GroupRoleGrant | null>(null);
	let busy = $state(false);

	const editable = $derived(access.rolesWrite && access.groupsWrite);
	const names = new GroupNames(untrack(() => client));
	const groupName = (id: string) => names.name(id);
	const searchGroups = $derived(
		groupSearch(client, {
			typedAsId: t('az.picker.groupTypedId'),
			searchRefused: t('az.picker.groupSearchRefused')
		})
	);
	const label = (grant: GroupRoleGrant) =>
		grant.role_display_name ?? grant.role_name ?? grant.role_id;
	const tierOf = (grant: GroupRoleGrant) =>
		choices?.find((role) => role.id === grant.role_id)?.grant_tier;

	// The roles' tiers, so a grant above the admin's ceiling is not offered for removal.
	$effect(() => {
		if (!access.rolesRead) return;
		untrack(() =>
			roles
				.list()
				.then((value) => (choices ??= value))
				.catch(() => undefined)
		);
	});

	async function openGrant() {
		granting = true;
		if (choices) return;
		try {
			choices = await roles.list();
		} catch {
			// Not kept as "no roles": opening the dialog again asks again.
			toast.error(t('eur.list.loadFailed'));
		}
	}

	async function grant(input: GroupRoleInput) {
		await client.grantRole(group.id, input);
		granting = false;
		toast.success(t('grp.toast.roleGranted'));
		await onchanged();
	}

	async function revoke() {
		const target = removing;
		if (!target) return;
		busy = true;
		try {
			await client.revokeRole(group.id, target);
			toast.success(t('grp.toast.roleRevoked', { role: label(target) }));
			await onchanged();
		} catch (failure) {
			toast.error(refusalText(failure, t));
		} finally {
			removing = null;
			busy = false;
		}
	}

	const columns = $derived([
		{ key: 'role', label: t('grp.roles.col.role') },
		{ key: 'scope', label: t('grp.roles.col.scope'), width: '30%' },
		{ key: 'ends', label: t('grp.roles.col.ends'), width: '20%' },
		...(editable
			? [
					{
						key: 'actions',
						label: t('grp.roles.col.actions', { name: '' }),
						width: '56px',
						hideLabel: true
					}
				]
			: [])
	]);
</script>

<Card
	title={t('grp.roles')}
	description={t('grp.roles.desc', { ceiling: access.grantCeiling })}
	flush
>
	{#snippet actions()}
		{#if editable}
			<Button size="sm" icon="plus" onclick={openGrant}>{t('grp.roles.add')}</Button>
		{/if}
	{/snippet}
	<DataTable
		caption={t('grp.roles')}
		{columns}
		rows={group.roles}
		rowKey={(row) => row.id}
		onrowopen={onopenrole && ((row) => onopenrole(row.role_id))}
		rowOpenLabel={(row) => t('eur.list.open', { name: label(row) })}
	>
		{#snippet cell(row, column)}
			{#if column.key === 'role'}
				<CellText title={label(row)} description={row.role_name ?? undefined} />
			{:else if column.key === 'scope'}
				<CellText
					title={t(SCOPE_LABEL[row.scope_type])}
					description={scopeText(row.scope_type, row.scope_target, groupName) || undefined}
				/>
			{:else if column.key === 'ends'}
				{#if row.expires_at}
					<DateTime value={row.expires_at} stacked />
				{:else}
					<span class="muted">{t('grp.members.noEnd')}</span>
				{/if}
			{:else}
				{@const tier = tierOf(row)}
				<ActionMenu
					size="sm"
					label={t('grp.roles.col.actions', { name: label(row) })}
					actions={[
						{
							label: t('grp.roles.remove'),
							icon: 'trash',
							danger: true,
							disabled: busy || (tier !== undefined && tier > access.grantCeiling),
							onselect: () => (removing = row)
						}
					]}
				/>
			{/if}
		{/snippet}
		{#snippet empty()}
			<EmptyState icon="shield" title={t('grp.roles.empty')} />
		{/snippet}
	</DataTable>
	{#if group.parent_chain.length > 0}
		<p class="inherited">
			<Badge>{t('grp.roles.inherited')}</Badge>
			{t('grp.roles.inheritedNote', {
				groups: group.parent_chain.map((parent) => parent.display_name).join(', ')
			})}
		</p>
	{/if}
</Card>

<RoleGrantDialog
	open={granting}
	title={t('grp.roles.add.title', { name: group.display_name })}
	roles={choices}
	ceiling={access.grantCeiling}
	groupSearch={searchGroups}
	{zone}
	onsubmit={grant}
	oncancel={() => (granting = false)}
/>

<ConfirmDialog
	open={removing !== null}
	title={t('grp.roles.remove.title', { role: removing ? label(removing) : '' })}
	body={t('grp.roles.remove.body')}
	confirmLabel={t('grp.roles.remove')}
	tone="danger"
	{busy}
	onconfirm={revoke}
	oncancel={() => (removing = null)}
/>

<style>
	.muted {
		color: var(--text-muted);
	}

	.inherited {
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		gap: var(--space-related);
		margin: 0;
		padding: var(--box-pad);
		color: var(--text-muted);
	}
</style>
