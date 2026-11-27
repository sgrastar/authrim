<script lang="ts">
	import { untrack } from 'svelte';
	import type { AuthzAccess } from '#lib/access/access.js';
	import { ApiError } from '#lib/api/api-error.js';
	import type {
		EndUserRole,
		EndUserRolesClient,
		RoleGroupAssignment,
		RoleUserAssignment
	} from '#lib/api/end-user-roles.js';
	import { t } from '#lib/i18n/i18n.svelte.js';
	import BusyScope from '#lib/ui/busy/BusyScope.svelte';
	import Callout from '#lib/ui/patterns/Callout.svelte';
	import Card from '#lib/ui/patterns/Card.svelte';
	import CellText from '#lib/ui/patterns/CellText.svelte';
	import DangerZone from '#lib/ui/patterns/DangerZone.svelte';
	import DataTable from '#lib/ui/patterns/DataTable.svelte';
	import DetailItem from '#lib/ui/patterns/DetailItem.svelte';
	import DetailList from '#lib/ui/patterns/DetailList.svelte';
	import EmptyState from '#lib/ui/patterns/EmptyState.svelte';
	import LoadingState from '#lib/ui/patterns/LoadingState.svelte';
	import PageHeader from '#lib/ui/patterns/PageHeader.svelte';
	import TextRow from '#lib/ui/patterns/TextRow.svelte';
	import BackLink from '#lib/ui/primitives/BackLink.svelte';
	import Badge from '#lib/ui/primitives/Badge.svelte';
	import Button from '#lib/ui/primitives/Button.svelte';
	import Page from '#lib/ui/templates/Page.svelte';
	import DateTime from '#lib/ui/time/DateTime.svelte';
	import { toast } from '#lib/ui/toast/toast.svelte.js';
	import { refusalText } from './authz-errors';
	import EndUserRoleEditor from './EndUserRoleEditor.svelte';
	import { SCOPE_LABEL } from './group-model';
	import {
		draftOf,
		permissionsByResource,
		roleChanges,
		roleLabel,
		roleNameProblem,
		withinCeiling,
		type RoleDraft
	} from './role-model';

	/**
	 * Access → Roles → one role (`new` for a new one): its permissions and grant tier, and who has
	 * it directly or through a group. A preset role, or one above the admin's grant ceiling, is shown as it is; a
	 * custom one within it is edited (its name is set once) and deleted while nobody has it.
	 */
	interface Props {
		client: EndUserRolesClient;
		/** A role's id, or `new`. */
		roleId: string;
		access: AuthzAccess;
		listHref: string;
		oncreated: (roleId: string) => void;
		ondeleted: () => void;
		/** Opens a user's page. */
		onopenuser?: (userId: string) => void;
		/** Opens a group's page. */
		onopengroup?: (groupId: string) => void;
		pageSize?: number;
	}

	let {
		client,
		roleId,
		access,
		listHref,
		oncreated,
		ondeleted,
		onopenuser,
		onopengroup,
		pageSize = 20
	}: Props = $props();

	const creating = $derived(roleId === 'new');
	const empty = (): RoleDraft => ({ description: '', permissions: [], grant_tier: 1 });

	let role = $state<EndUserRole | null>(null);
	let holders = $state<RoleUserAssignment[]>([]);
	let holdersTotal = $state(0);
	let nextPage = $state<number | null>(null);
	let groupGrants = $state<RoleGroupAssignment[]>([]);
	let groupGrantsTotal = $state(0);
	let nextGroupPage = $state<number | null>(null);
	/** A "load more" of each list runs once at a time (a second click would read a page twice). */
	let loadingHolders = $state(false);
	let loadingGroups = $state(false);
	let groupGrantsFailed = $state(false);
	let phase = $state<'loading' | 'ready' | 'notFound' | 'forbidden' | 'failed'>('loading');
	let draft = $state<RoleDraft>(empty());
	let saved = $state<RoleDraft>(empty());
	let roleName = $state('');
	let permissionsInvalid = $state(false);
	let busy = $state(false);
	let tried = $state(false);
	let refusal = $state('');

	async function load() {
		phase = 'loading';
		try {
			if (roleId === 'new') {
				role = null;
				holders = [];
				groupGrants = [];
			} else {
				const [detail, page, groupPage] = await Promise.all([
					client.get(roleId),
					client.assignments(roleId, { page: 1, limit: pageSize }),
					// The groups are a second list: if it fails the role and its users are still shown.
					client.groupAssignments(roleId, { page: 1, limit: pageSize }).catch(() => null)
				]);
				role = detail;
				holders = page.items;
				holdersTotal = page.total;
				nextPage = page.hasNext ? page.page + 1 : null;
				groupGrantsFailed = groupPage === null;
				groupGrants = groupPage?.items ?? [];
				groupGrantsTotal = groupPage?.total ?? 0;
				nextGroupPage = groupPage?.hasNext ? groupPage.page + 1 : null;
				saved = draftOf(detail);
				draft = draftOf(detail);
			}
			phase = 'ready';
		} catch (failure) {
			role = null;
			phase =
				failure instanceof ApiError && failure.status === 404
					? 'notFound'
					: failure instanceof ApiError && failure.status === 403
						? 'forbidden'
						: 'failed';
		}
	}

	async function loadMore() {
		if (!nextPage || !role || loadingHolders) return;
		loadingHolders = true;
		try {
			const page = await client.assignments(role.id, { page: nextPage, limit: pageSize });
			holders = [...holders, ...page.items];
			nextPage = page.hasNext ? page.page + 1 : null;
		} catch {
			toast.error(t('eur.d.holders.loadFailed'));
		} finally {
			loadingHolders = false;
		}
	}

	async function loadMoreGroups() {
		if (!nextGroupPage || !role || loadingGroups) return;
		loadingGroups = true;
		try {
			const page = await client.groupAssignments(role.id, {
				page: nextGroupPage,
				limit: pageSize
			});
			groupGrants = [...groupGrants, ...page.items];
			nextGroupPage = page.hasNext ? page.page + 1 : null;
		} catch {
			toast.error(t('eur.d.groups.loadFailed'));
		} finally {
			loadingGroups = false;
		}
	}

	$effect(() => {
		void roleId;
		untrack(() => void load());
	});

	const editable = $derived(
		access.rolesWrite &&
			(creating
				? access.grantCeiling > 0
				: role !== null && !role.is_system && withinCeiling(role, access.grantCeiling))
	);
	const nameProblem = $derived(creating ? roleNameProblem(roleName) : undefined);
	const noPermissions = $derived(draft.permissions.filter((p) => p.trim()).length === 0);

	async function save() {
		tried = true;
		refusal = '';
		if (nameProblem || noPermissions || permissionsInvalid) return;
		busy = true;
		try {
			if (creating) {
				const created = await client.create({ ...draft, name: roleName });
				toast.success(t('eur.toast.created', { name: created.name || roleName.trim() }));
				oncreated(created.id);
				return;
			}
			if (!role) return;
			const changes = roleChanges(saved, draft);
			if (Object.keys(changes).length === 0) {
				toast.info(t('eur.d.noChanges'));
				return;
			}
			await client.update(role.id, changes);
			toast.success(t('eur.d.saved'));
			await load();
		} catch (failure) {
			refusal = refusalText(failure, t);
		} finally {
			busy = false;
		}
	}

	async function remove() {
		if (!role) return;
		const label = roleLabel(role);
		try {
			await client.remove(role.id);
		} catch (failure) {
			toast.error(refusalText(failure, t));
			return;
		}
		toast.success(t('eur.toast.deleted', { name: label }));
		ondeleted();
	}

	const holderColumns = $derived([
		{ key: 'user', label: t('eur.d.holders.col.user') },
		{ key: 'scope', label: t('eur.d.holders.col.scope'), width: '26%' },
		{ key: 'ends', label: t('eur.d.holders.col.ends'), width: '22%' }
	]);
	const groupColumns = $derived([
		{ key: 'group', label: t('eur.d.groups.col.group') },
		{ key: 'scope', label: t('eur.d.groups.col.scope'), width: '26%' },
		{ key: 'ends', label: t('eur.d.groups.col.ends'), width: '22%' }
	]);
	const title = $derived(
		creating ? t('eur.new.title') : role ? roleLabel(role) : t('nav.access.roles')
	);
</script>

<Page>
	<PageHeader {title}>
		{#snippet back()}
			<BackLink href={listHref}>{t('eur.d.back')}</BackLink>
		{/snippet}
		{#snippet badges()}
			{#if role}
				{#if role.is_system}<Badge>{t('eur.kind.system')}</Badge>{/if}
				<Badge tone={role.grant_tier > access.grantCeiling ? 'warning' : 'neutral'}>
					{t('eur.tier.short', { tier: role.grant_tier })}
				</Badge>
			{/if}
		{/snippet}
	</PageHeader>

	{#if phase === 'loading'}
		<LoadingState label={t('common.loading')} />
	{:else if phase === 'notFound'}
		<EmptyState icon="shield" title={t('eur.d.notFound')} />
	{:else if phase === 'forbidden' || (creating && !editable)}
		<EmptyState icon="lock" title={t('eur.list.noAccess')} />
	{:else if phase === 'failed'}
		<EmptyState icon="warningCircle" title={t('eur.d.loadFailed')}>
			{#snippet action()}
				<Button size="sm" onclick={load}>{t('common.retry')}</Button>
			{/snippet}
		</EmptyState>
	{:else}
		{#if role?.is_system}
			<Callout icon="info">{t('eur.d.systemNote')}</Callout>
		{:else if role && !withinCeiling(role, access.grantCeiling)}
			<Callout icon="lock">{t('eur.d.aboveCeiling', { ceiling: access.grantCeiling })}</Callout>
		{/if}

		{#if editable}
			<BusyScope {busy}>
				<EndUserRoleEditor
					bind:draft
					ceiling={access.grantCeiling}
					savedTier={role?.grant_tier}
					permissionsError={tried && noPermissions ? t('eur.new.permissionsNone') : undefined}
					bind:permissionsInvalid
				>
					{#snippet name()}
						{#if creating}
							<TextRow
								label={t('eur.new.name')}
								required
								maxlength={50}
								hint={t('eur.new.nameHint')}
								error={tried && nameProblem ? t(nameProblem) : undefined}
								bind:value={roleName}
							/>
						{:else if role}
							<TextRow label={t('eur.new.name')} value={role.name} readonly />
						{/if}
					{/snippet}
				</EndUserRoleEditor>
			</BusyScope>
			{#if refusal}
				<Callout tone="danger" live>{refusal}</Callout>
			{/if}
			<div class="actions">
				<Button variant="primary" loading={busy} onclick={save}>
					{creating ? t('eur.new.submit') : t('eur.d.save')}
				</Button>
			</div>
		{:else if role}
			<Card title={t('eur.d.profile')}>
				<DetailList columns={2} ruled>
					<DetailItem label={t('eur.new.name')}><code>{role.name}</code></DetailItem>
					<DetailItem label={t('eur.new.tier')}
						>{t('eur.tier.option', { tier: role.grant_tier })}</DetailItem
					>
					<DetailItem label={t('eur.new.description')}>{role.description ?? '—'}</DetailItem>
				</DetailList>
			</Card>
			<Card title={t('eur.new.permissions')}>
				{#if role.permissions.length === 0}
					<p class="muted">{t('eur.d.noPermissions')}</p>
				{:else}
					<dl class="permissions">
						{#each permissionsByResource(role.permissions) as [resource, actions] (resource)}
							<dt><code>{resource}</code></dt>
							<dd>{actions.join(', ')}</dd>
						{/each}
					</dl>
				{/if}
			</Card>
		{/if}

		{#if role}
			<Card title={t('eur.d.holders')} description={t('eur.d.holders.desc')} flush>
				<p class="count">{t('eur.d.holders.count', { count: holdersTotal })}</p>
				<DataTable
					caption={t('eur.d.holders')}
					columns={holderColumns}
					rows={holders}
					rowKey={(row) => row.id}
					onrowopen={onopenuser && ((row) => onopenuser(row.user_id))}
					rowOpenLabel={(row) =>
						t('grp.members.open', { name: row.name ?? row.email ?? row.user_id })}
				>
					{#snippet cell(row, column)}
						{#if column.key === 'user'}
							<CellText
								title={row.name ?? row.email ?? row.user_id}
								description={row.name ? (row.email ?? undefined) : undefined}
							/>
						{:else if column.key === 'scope'}
							<CellText
								title={t(SCOPE_LABEL[row.scope_type])}
								description={row.scope_target || undefined}
							/>
						{:else if row.expires_at}
							<DateTime value={row.expires_at} stacked />
						{:else}
							<span class="muted">{t('grp.members.noEnd')}</span>
						{/if}
					{/snippet}
					{#snippet empty()}
						<EmptyState icon="users" title={t('eur.d.holders.empty')} />
					{/snippet}
				</DataTable>
				{#if nextPage}
					<div class="more">
						<Button size="sm" loading={loadingHolders} onclick={loadMore}
							>{t('grp.members.more')}</Button
						>
					</div>
				{/if}
			</Card>

			<Card title={t('eur.d.groups')} description={t('eur.d.groups.desc')} flush>
				{#if groupGrantsFailed}
					<p class="count">{t('eur.d.groups.loadFailed')}</p>
				{:else}
					<p class="count">{t('eur.d.groups.count', { count: groupGrantsTotal })}</p>
					<DataTable
						caption={t('eur.d.groups')}
						columns={groupColumns}
						rows={groupGrants}
						rowKey={(row) => row.id}
						onrowopen={onopengroup &&
							((row) => {
								if (row.group_key !== null) onopengroup(row.group_id);
							})}
						rowOpenLabel={(row) =>
							t('grp.members.open', { name: row.group_display_name ?? row.group_id })}
					>
						{#snippet cell(row, column)}
							{#if column.key === 'group'}
								<CellText
									title={row.group_display_name ?? t('eur.d.groups.deleted')}
									description={row.group_key ?? undefined}
								/>
							{:else if column.key === 'scope'}
								<CellText
									title={t(SCOPE_LABEL[row.scope_type])}
									description={row.scope_target || undefined}
								/>
							{:else if row.expires_at}
								<DateTime value={row.expires_at} stacked />
							{:else}
								<span class="muted">{t('grp.members.noEnd')}</span>
							{/if}
						{/snippet}
						{#snippet empty()}
							<EmptyState icon="users" title={t('eur.d.groups.empty')} />
						{/snippet}
					</DataTable>
					{#if nextGroupPage}
						<div class="more">
							<Button size="sm" loading={loadingGroups} onclick={loadMoreGroups}
								>{t('grp.members.more')}</Button
							>
						</div>
					{/if}
				{/if}
			</Card>

			<!-- Deleting is its own permission: a custom role within the ceiling, write or not. -->
			{#if access.rolesDelete && !role.is_system && withinCeiling(role, access.grantCeiling)}
				<DangerZone
					title={t('eur.d.delete.title')}
					description={t('eur.d.delete.desc')}
					actionLabel={t('eur.d.delete.action')}
					confirmTitle={t('eur.d.delete.confirmTitle', { name: roleLabel(role) })}
					confirmBody={t('eur.d.delete.confirmBody')}
					onconfirm={remove}
				/>
			{/if}
		{/if}
	{/if}
</Page>

<style>
	.actions {
		display: flex;
		gap: var(--space-related);
	}

	.muted {
		margin: 0;
		color: var(--text-muted);
	}

	.count {
		margin: 0;
		padding: var(--box-pad);
		color: var(--text-muted);
	}

	.more {
		padding: var(--box-pad);
	}

	.permissions {
		display: grid;
		grid-template-columns: max-content 1fr;
		gap: var(--space-related) 16px;
		margin: 0;
	}

	.permissions dd {
		margin: 0;
	}
</style>
