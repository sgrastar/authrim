<script lang="ts">
	import { untrack } from 'svelte';
	import type { AdminAccess, TeamAccess } from '#lib/access/access.js';
	import type {
		AdminRoleDetail,
		AdminRolesClient,
		PermissionChoice,
		RoleAssignment
	} from '#lib/api/admin-roles.js';
	import { ApiError } from '#lib/api/api-error.js';
	import { t, type MessageKey } from '#lib/i18n/i18n.svelte.js';
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
	import BusyScope from '#lib/ui/busy/BusyScope.svelte';
	import RoleEditor from './RoleEditor.svelte';
	import { draftOf, roleChanges, roleNameProblem, type RoleDraft } from './role-model';
	import { teamErrorKey } from './team-errors';
	import { roleLabel } from './team-model';

	/**
	 * Settings → Administrator roles → one role (`new` for a new one). A built-in role is shown as
	 * it is; a custom one is edited (its name is set once) and can be deleted while nobody holds
	 * it. Who holds it: the number (through groups included), and those given it directly.
	 */
	interface Props {
		client: AdminRolesClient;
		/** A role's id, or `new`. */
		roleId: string;
		access: TeamAccess;
		/** Who is editing (the permissions they can give). */
		who: AdminAccess;
		listHref: string;
		oncreated: (roleId: string) => void;
		ondeleted: () => void;
		/** Opens an administrator's page. */
		onopenadmin?: (adminId: string) => void;
	}

	let { client, roleId, access, who, listHref, oncreated, ondeleted, onopenadmin }: Props =
		$props();

	const creating = $derived(roleId === 'new');
	const empty: RoleDraft = {
		display_name: '',
		description: '',
		permissions: [],
		hierarchy_level: 10
	};

	let role = $state<AdminRoleDetail | null>(null);
	let permissions = $state<PermissionChoice[]>([]);
	let holders = $state<RoleAssignment[]>([]);
	let phase = $state<'loading' | 'ready' | 'notFound' | 'forbidden' | 'failed'>('loading');
	let draft = $state<RoleDraft>(structuredClone(empty));
	let saved = $state<RoleDraft>(structuredClone(empty));
	let roleName = $state('');
	let busy = $state(false);
	let tried = $state(false);
	let refusal = $state('');

	async function load() {
		phase = 'loading';
		try {
			if (roleId === 'new') {
				permissions = await client.permissions();
				role = null;
				holders = [];
			} else {
				const [detail, list, assigned] = await Promise.all([
					client.get(roleId),
					client.permissions(),
					client.assignments(roleId)
				]);
				role = detail;
				permissions = list;
				holders = assigned;
				// Two separate copies (a state proxy cannot be cloned with structuredClone).
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

	$effect(() => {
		void roleId;
		untrack(() => void load());
	});

	const editable = $derived(access.rolesEdit && (creating || (role !== null && !role.is_system)));
	const nameProblem = $derived(creating ? roleNameProblem(roleName) : undefined);
	// A new role needs a permission; an existing one may keep none of its own (it may inherit).
	const noPermissions = $derived(creating && draft.permissions.length === 0);
	let rankInvalid = $state(false);

	/** What a refusal from the roles API means here (its 409 and 403 carry no code of their own). */
	function refusalOf(failure: unknown, conflict: MessageKey): string {
		if (failure instanceof ApiError && failure.status === 403) return t('tr.error.beyondYou');
		return t(teamErrorKey(failure, 'tm.error.generic', conflict));
	}

	async function save() {
		tried = true;
		refusal = '';
		if (nameProblem || noPermissions || rankInvalid) return;
		busy = true;
		try {
			if (creating) {
				const created = await client.create({ ...draft, name: roleName });
				toast.success(t('tr.toast.created', { name: created.display_name ?? created.name }));
				oncreated(created.id);
				return;
			}
			if (!role) return;
			const changes = roleChanges(saved, draft);
			if (Object.keys(changes).length === 0) {
				toast.info(t('tr.d.noChanges'));
				return;
			}
			await client.update(role.id, changes);
			toast.success(t('tr.d.saved'));
			await load();
		} catch (failure) {
			// A 409 is a name already used when creating, a change made meanwhile when saving.
			refusal = refusalOf(failure, creating ? 'tr.error.nameTaken' : 'tm.error.changed');
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
			toast.error(refusalOf(failure, 'tr.error.inUse'));
			return;
		}
		toast.success(t('tr.toast.deleted', { name: label }));
		ondeleted();
	}

	const holderColumns = $derived([
		{ key: 'admin', label: t('tr.d.holders.col.admin') },
		{ key: 'scope', label: t('tr.d.holders.col.scope'), width: '20%' },
		{ key: 'ends', label: t('tr.d.holders.col.ends'), width: '24%' }
	]);
	const title = $derived(
		creating ? t('tr.new.title') : role ? roleLabel(role) : t('nav.set.teamRoles')
	);
</script>

<Page>
	<PageHeader {title}>
		{#snippet back()}
			<BackLink href={listHref}>{t('tr.d.back')}</BackLink>
		{/snippet}
		{#snippet badges()}
			{#if role}
				<Badge tone={role.is_system ? 'neutral' : 'info'}>
					{role.is_system ? t('tr.kind.system') : t('tr.kind.custom')}
				</Badge>
			{/if}
		{/snippet}
	</PageHeader>

	{#if phase === 'loading'}
		<LoadingState label={t('common.loading')} />
	{:else if phase === 'notFound'}
		<EmptyState icon="shield" title={t('tr.d.notFound')} />
	{:else if phase === 'forbidden'}
		<EmptyState icon="lock" title={t('tr.list.noAccess')} />
	{:else if phase === 'failed'}
		<EmptyState icon="warningCircle" title={t('tr.d.loadFailed')}>
			{#snippet action()}
				<Button size="sm" onclick={load}>{t('common.retry')}</Button>
			{/snippet}
		</EmptyState>
	{:else if creating && !access.rolesEdit}
		<EmptyState icon="lock" title={t('tr.list.noAccess')} />
	{:else}
		{#if role?.is_system}
			<Callout icon="info">{t('tr.d.systemNote')}</Callout>
		{/if}

		{#if editable}
			<BusyScope {busy}>
				<RoleEditor
					bind:draft
					{permissions}
					access={who}
					permissionsError={tried && noPermissions ? t('tr.new.permissionsNone') : undefined}
					rankError={tried && rankInvalid ? t('tr.new.rankInvalid') : undefined}
					inheritsFrom={role?.inherits_from ?? null}
					savedPermissions={role?.permissions ?? []}
					bind:rankInvalid
				>
					{#snippet name()}
						{#if creating}
							<TextRow
								label={t('tr.new.name')}
								required
								maxlength={64}
								hint={t('tr.new.nameHint')}
								error={tried && nameProblem ? t(nameProblem) : undefined}
								bind:value={roleName}
							/>
						{:else if role}
							<TextRow label={t('tr.d.name')} value={role.name} readonly />
						{/if}
					{/snippet}
				</RoleEditor>
			</BusyScope>

			{#if refusal}
				<Callout tone="danger" live>{refusal}</Callout>
			{/if}
			<div class="actions">
				<Button variant="primary" loading={busy} onclick={save}>
					{creating ? t('tr.new.submit') : t('tr.d.save')}
				</Button>
			</div>
		{:else if role}
			<Card title={t('tr.d.profile')}>
				<DetailList columns={2} ruled>
					<DetailItem label={t('tr.d.name')}>{role.name}</DetailItem>
					<DetailItem label={t('tr.new.rank')}>{role.hierarchy_level}</DetailItem>
					<DetailItem label={t('tr.new.description')}>{role.description ?? '—'}</DetailItem>
					{#if role.inherits_from}
						<DetailItem label={t('tr.d.inherits')}>{role.inherits_from}</DetailItem>
					{/if}
				</DetailList>
			</Card>
			<Card title={t('tr.new.permissions')}>
				<ul class="permissions">
					{#each role.permissions as permission (permission)}
						<li><code>{permission}</code></li>
					{/each}
				</ul>
			</Card>
		{/if}

		{#if role}
			<Card title={t('tr.d.holders')} description={t('tr.d.holders.desc')} flush>
				<p class="count">{t('tr.d.holders.count', { count: role.holder_count })}</p>
				<DataTable
					caption={t('tr.d.holders')}
					columns={holderColumns}
					rows={holders}
					rowKey={(row) => row.id}
					onrowopen={onopenadmin && ((row) => onopenadmin(row.admin_user_id))}
					rowOpenLabel={(row) =>
						t('tm.list.open', { name: row.name ?? row.email ?? row.admin_user_id })}
				>
					{#snippet cell(row, column)}
						{#if column.key === 'admin'}
							<CellText
								title={row.name ?? row.email ?? row.admin_user_id}
								description={row.name ? (row.email ?? undefined) : undefined}
							/>
						{:else if column.key === 'scope'}
							{#if row.scope_type === 'global'}
								<Badge tone="warning">{t('tm.d.scope.global')}</Badge>
							{:else}
								{t('tm.d.scope.tenant')}
							{/if}
						{:else if row.expires_at}
							<DateTime value={row.expires_at} stacked />
						{:else}
							{t('tm.d.noEnd')}
						{/if}
					{/snippet}
					{#snippet empty()}
						<EmptyState icon="users" title={t('tr.d.holders.empty')} />
					{/snippet}
				</DataTable>
			</Card>

			{#if editable}
				<DangerZone
					title={t('tr.d.delete.title')}
					description={t('tr.d.delete.desc')}
					actionLabel={t('tr.d.delete.action')}
					confirmTitle={t('tr.d.delete.confirmTitle', { name: roleLabel(role) })}
					confirmBody={t('tr.d.delete.confirmBody')}
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

	.permissions {
		display: flex;
		flex-wrap: wrap;
		gap: var(--space-related);
		margin: 0;
		padding: 0;
		list-style: none;
	}

	.count {
		margin: 0;
		padding: var(--box-pad);
		color: var(--text-muted);
	}
</style>
