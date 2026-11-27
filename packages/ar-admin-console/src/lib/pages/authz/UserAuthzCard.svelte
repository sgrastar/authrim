<script lang="ts">
	import { untrack } from 'svelte';
	import type { AuthzAccess } from '#lib/access/access.js';
	import type {
		EndUserGroupsClient,
		GroupRoleInput,
		UserGroups
	} from '#lib/api/end-user-groups.js';
	import type {
		EffectiveRole,
		EndUserRole,
		EndUserRolesClient,
		UserRoleAssignment
	} from '#lib/api/end-user-roles.js';
	import { t } from '#lib/i18n/i18n.svelte.js';
	import Card from '#lib/ui/patterns/Card.svelte';
	import CellText from '#lib/ui/patterns/CellText.svelte';
	import ConfirmDialog from '#lib/ui/patterns/ConfirmDialog.svelte';
	import DataTable from '#lib/ui/patterns/DataTable.svelte';
	import EmptyState from '#lib/ui/patterns/EmptyState.svelte';
	import LoadingState from '#lib/ui/patterns/LoadingState.svelte';
	import ActionMenu from '#lib/ui/primitives/ActionMenu.svelte';
	import Badge from '#lib/ui/primitives/Badge.svelte';
	import Button from '#lib/ui/primitives/Button.svelte';
	import Link from '#lib/ui/primitives/Link.svelte';
	import DateTime from '#lib/ui/time/DateTime.svelte';
	import type { TimeZoneMode } from '#lib/ui/time/format-time.js';
	import { toast } from '#lib/ui/toast/toast.svelte.js';
	import { refusalText } from './authz-errors';
	import { SCOPE_LABEL, SOURCE_LABEL, scopeText } from './group-model';
	import { GroupNames } from './group-names.svelte';
	import RoleGrantDialog from './RoleGrantDialog.svelte';
	import { groupSearch } from './user-picker';
	import { withinCeiling } from './role-model';

	/**
	 * A user's groups and what they may do: the groups they are in (and the groups above those,
	 * whose roles they hold too), every role they hold now with where it comes from (given to them,
	 * or through a group), and the roles given to them directly, which can be given and taken
	 * away here. Each part loads on its own, so one failing never blanks the others.
	 */
	interface Props {
		groups: EndUserGroupsClient;
		roles: EndUserRolesClient;
		userId: string;
		access: AuthzAccess;
		groupHref: (groupId: string) => string;
		/** Bumped when the user changed elsewhere on the page. */
		refresh?: number;
		zone?: TimeZoneMode;
	}

	let { groups, roles, userId, access, groupHref, refresh = 0, zone }: Props = $props();

	let memberships = $state<UserGroups | null>(null);
	let effective = $state<EffectiveRole[] | null>(null);
	let direct = $state<UserRoleAssignment[] | null>(null);
	let failed = $state<string[]>([]);
	let roleChoices = $state<EndUserRole[] | null>(null);
	let granting = $state(false);
	let removing = $state<UserRoleAssignment | null>(null);
	let busy = $state(false);

	async function load() {
		failed = [];
		const parts: Promise<void>[] = [];
		if (access.groupsRead)
			parts.push(
				groups
					.userGroups(userId)
					.then((value) => void (memberships = value))
					.catch(() => void (failed = [...failed, 'groups']))
			);
		if (access.rolesRead) {
			parts.push(
				roles
					.effectivePermissions(userId)
					.then((value) => void (effective = value.roles))
					.catch(() => void (failed = [...failed, 'effective']))
			);
			// The roles' tiers: a grant above the admin's ceiling cannot be taken away here.
			if (!roleChoices)
				parts.push(
					roles
						.list()
						.then((value) => void (roleChoices = value))
						.catch(() => undefined)
				);
			parts.push(
				roles
					.userRoles(userId)
					.then((value) => void (direct = value))
					.catch(() => void (failed = [...failed, 'direct']))
			);
		}
		await Promise.all(parts);
	}

	$effect(() => {
		void [userId, refresh];
		untrack(() => void load());
	});
	// Names of the groups mentioned by id: those the user's groups answer gave, the others read
	// one by one (an id is shown until then, or if it cannot be read).
	const names = new GroupNames(untrack(() => groups));
	const groupName = (id: string) =>
		memberships?.effective.find((group) => group.id === id)?.display_name ??
		memberships?.memberships.find((row) => row.group_id === id)?.display_name ??
		(access.groupsRead ? names.name(id) : undefined);
	const searchGroups = $derived(
		groupSearch(groups, {
			typedAsId: t('az.picker.groupTypedId'),
			searchRefused: t('az.picker.groupSearchRefused')
		})
	);
	const editable = $derived(access.rolesWrite);

	async function openGrant() {
		granting = true;
		if (roleChoices) return;
		try {
			roleChoices = await roles.list();
		} catch {
			// Not kept as "no roles": opening the dialog again asks again.
			toast.error(t('eur.list.loadFailed'));
		}
	}

	async function grant(input: GroupRoleInput) {
		await roles.assignToUser(userId, input);
		granting = false;
		toast.success(t('az.user.toast.granted'));
		await load();
	}

	async function revoke() {
		const target = removing;
		if (!target) return;
		busy = true;
		try {
			await roles.removeFromUser(userId, target.id);
			toast.success(
				t('az.user.toast.revoked', { role: target.role_display_name ?? target.role_name })
			);
			await load();
		} catch (failure) {
			toast.error(refusalText(failure, t));
		} finally {
			removing = null;
			busy = false;
		}
	}

	const tierOf = (roleId: string) => roleChoices?.find((role) => role.id === roleId);

	const groupColumns = $derived([
		{ key: 'group', label: t('az.user.groups.col.group') },
		{ key: 'source', label: t('grp.members.col.source'), width: '22%' },
		{ key: 'effective', label: t('grp.members.col.effective'), width: '20%' }
	]);
	const effectiveColumns = $derived([
		{ key: 'role', label: t('grp.roles.col.role') },
		{ key: 'scope', label: t('grp.roles.col.scope'), width: '26%' },
		{ key: 'via', label: t('az.user.roles.col.via'), width: '30%' }
	]);
	const directColumns = $derived([
		{ key: 'role', label: t('grp.roles.col.role') },
		{ key: 'scope', label: t('grp.roles.col.scope'), width: '30%' },
		{ key: 'ends', label: t('grp.roles.col.ends'), width: '22%' },
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
	const ancestors = $derived(memberships?.effective.filter((group) => !group.direct) ?? []);
</script>

{#if access.groupsRead || access.rolesRead}
	<Card title={t('az.user.title')} description={t('az.user.desc')}>
		{#if access.groupsRead}
			<section class="part" aria-labelledby="authz-groups">
				<h3 id="authz-groups" class="part__title">{t('az.user.groups')}</h3>
				{#if failed.includes('groups')}
					<p class="muted">{t('az.user.loadFailed')}</p>
				{:else if memberships === null}
					<LoadingState label={t('common.loading')} />
				{:else}
					<DataTable
						caption={t('az.user.groups')}
						columns={groupColumns}
						rows={memberships.memberships}
						rowKey={(row) => `${row.group_id}:${row.source}:${row.source_ref ?? ''}`}
					>
						{#snippet cell(row, column)}
							{#if column.key === 'group'}
								<span class="via">
									<Link href={groupHref(row.group_id)}>{row.display_name ?? row.group_id}</Link>
									{#if row.group_key}<code class="muted">{row.group_key}</code>{/if}
								</span>
							{:else if column.key === 'source'}
								<Badge tone={row.source === 'manual' ? 'neutral' : 'info'}
									>{t(SOURCE_LABEL[row.source])}</Badge
								>
							{:else if row.effective}
								<Badge tone="success" dot>{t('grp.members.effective')}</Badge>
							{:else}
								<Badge dot>{t('grp.members.notEffective')}</Badge>
							{/if}
						{/snippet}
						{#snippet empty()}
							<EmptyState icon="users" title={t('az.user.groups.empty')} />
						{/snippet}
					</DataTable>
					{#if ancestors.length > 0}
						<p class="muted">
							{t('az.user.groups.ancestors')}
							{#each ancestors as group, index (group.id)}
								{#if index > 0},
								{/if}
								<Link href={groupHref(group.id)}>{group.display_name ?? group.id}</Link>
							{/each}
						</p>
					{/if}
				{/if}
			</section>
		{/if}

		{#if access.rolesRead}
			<section class="part" aria-labelledby="authz-effective">
				<h3 id="authz-effective" class="part__title">{t('az.user.effective')}</h3>
				{#if failed.includes('effective')}
					<p class="muted">{t('az.user.loadFailed')}</p>
				{:else if effective === null}
					<LoadingState label={t('common.loading')} />
				{:else}
					<DataTable
						caption={t('az.user.effective')}
						columns={effectiveColumns}
						rows={effective}
						rowKey={(row) =>
							`${row.role_id}:${row.scope_type}:${row.scope_target}:${
								row.via.kind === 'group'
									? `${row.via.group_id}<${row.via.through_group_id ?? ''}`
									: 'direct'
							}`}
					>
						{#snippet cell(row, column)}
							{#if column.key === 'role'}
								<CellText title={row.role_name} />
							{:else if column.key === 'scope'}
								<CellText
									title={t(SCOPE_LABEL[row.scope_type])}
									description={scopeText(row.scope_type, row.scope_target, groupName) || undefined}
								/>
							{:else if row.via.kind === 'direct'}
								<Badge>{t('az.user.via.direct')}</Badge>
							{:else}
								<span class="via">
									<Badge tone="info">{t('az.user.via.group')}</Badge>
									<Link href={groupHref(row.via.group_id)}>
										{groupName(row.via.group_id) ?? row.via.group_id}
									</Link>
									{#if row.via.through_group_id}
										<span class="muted">
											{t('az.user.via.through', {
												group: groupName(row.via.through_group_id) ?? row.via.through_group_id
											})}
										</span>
									{/if}
								</span>
							{/if}
						{/snippet}
						{#snippet empty()}
							<EmptyState icon="shield" title={t('az.user.effective.empty')} />
						{/snippet}
					</DataTable>
				{/if}
			</section>

			<section class="part" aria-labelledby="authz-direct">
				<div class="part__head">
					<h3 id="authz-direct" class="part__title">{t('az.user.direct')}</h3>
					{#if editable}
						<Button size="sm" icon="plus" onclick={openGrant}>{t('az.user.direct.add')}</Button>
					{/if}
				</div>
				{#if failed.includes('direct')}
					<p class="muted">{t('az.user.loadFailed')}</p>
				{:else if direct === null}
					<LoadingState label={t('common.loading')} />
				{:else}
					<DataTable
						caption={t('az.user.direct')}
						columns={directColumns}
						rows={direct}
						rowKey={(row) => row.id}
					>
						{#snippet cell(row, column)}
							{#if column.key === 'role'}
								<CellText
									title={row.role_display_name ?? row.role_name}
									description={row.role_name}
								/>
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
								{@const known = tierOf(row.role_id)}
								<ActionMenu
									size="sm"
									label={t('grp.roles.col.actions', { name: row.role_name })}
									actions={[
										{
											label: t('grp.roles.remove'),
											icon: 'trash',
											danger: true,
											disabled:
												busy || (known !== undefined && !withinCeiling(known, access.grantCeiling)),
											onselect: () => (removing = row)
										}
									]}
								/>
							{/if}
						{/snippet}
						{#snippet empty()}
							<EmptyState icon="shield" title={t('az.user.direct.empty')} />
						{/snippet}
					</DataTable>
				{/if}
			</section>
		{/if}
	</Card>

	<RoleGrantDialog
		open={granting}
		title={t('az.user.direct.add')}
		roles={roleChoices}
		ceiling={access.grantCeiling}
		groupSearch={searchGroups}
		{zone}
		onsubmit={grant}
		oncancel={() => (granting = false)}
	/>

	<ConfirmDialog
		open={removing !== null}
		title={t('grp.roles.remove.title', {
			role: removing ? (removing.role_display_name ?? removing.role_name) : ''
		})}
		body={t('az.user.direct.removeBody')}
		confirmLabel={t('grp.roles.remove')}
		tone="danger"
		{busy}
		onconfirm={revoke}
		oncancel={() => (removing = null)}
	/>
{/if}

<style>
	.part {
		display: grid;
		gap: var(--space-related);
	}

	.part + .part {
		margin-top: var(--space-section, 24px);
	}

	.part__head {
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		justify-content: space-between;
		gap: var(--space-related);
	}

	.part__title {
		margin: 0;
		font-size: var(--fs-label);
		font-weight: var(--fw-semibold);
	}

	.muted {
		margin: 0;
		color: var(--text-muted);
	}

	.via {
		display: inline-flex;
		flex-wrap: wrap;
		align-items: center;
		gap: 4px 8px;
	}
</style>
