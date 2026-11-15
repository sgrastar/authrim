<script lang="ts">
	import { untrack } from 'svelte';
	import type { MachineAccess } from '#lib/access/access.js';
	import { ApiError } from '#lib/api/api-error.js';
	import {
		MACHINE_PRINCIPAL_TYPES,
		MACHINE_TOKEN_TTL_MAX,
		type MachineAccessClient,
		type MachinePrincipal,
		type MachinePrincipalType,
		type MachineReach
	} from '#lib/api/machine-access.js';
	import { t } from '#lib/i18n/i18n.svelte.js';
	import Callout from '#lib/ui/patterns/Callout.svelte';
	import Card from '#lib/ui/patterns/Card.svelte';
	import ConfirmDialog from '#lib/ui/patterns/ConfirmDialog.svelte';
	import DetailItem from '#lib/ui/patterns/DetailItem.svelte';
	import DetailList from '#lib/ui/patterns/DetailList.svelte';
	import Disclosure from '#lib/ui/patterns/Disclosure.svelte';
	import EmptyState from '#lib/ui/patterns/EmptyState.svelte';
	import FormDialog from '#lib/ui/patterns/FormDialog.svelte';
	import LoadingState from '#lib/ui/patterns/LoadingState.svelte';
	import PageHeader from '#lib/ui/patterns/PageHeader.svelte';
	import BackLink from '#lib/ui/primitives/BackLink.svelte';
	import Badge from '#lib/ui/primitives/Badge.svelte';
	import Button from '#lib/ui/primitives/Button.svelte';
	import NumberField from '#lib/ui/primitives/NumberField.svelte';
	import TextArea from '#lib/ui/primitives/TextArea.svelte';
	import TextField from '#lib/ui/primitives/TextField.svelte';
	import Page from '#lib/ui/templates/Page.svelte';
	import DateTime from '#lib/ui/time/DateTime.svelte';
	import { toast } from '#lib/ui/toast/toast.svelte.js';
	import { machineErrorKey } from './machine-errors';
	import MachineGrantFields from './MachineGrantFields.svelte';
	import MachineKeys from './MachineKeys.svelte';
	import { reachProblem, tokenTtlProblem } from './machine-model';

	/**
	 * Platform → Administrators → Machine access → one machine. The main view is what almost
	 * everyone looks at: its state, the permissions and tenants it holds, and its keys. Rarely
	 * changed settings (description, token lifetime) are folded under "Advanced settings".
	 */
	interface Props {
		client: MachineAccessClient;
		principalId: string;
		access: MachineAccess;
		tenants: ReadonlyArray<{ id: string; name: string }>;
		listHref: string;
	}

	let { client, principalId, access: allowed, tenants, listHref }: Props = $props();

	let principal = $state<MachinePrincipal | null>(null);
	let phase = $state<'loading' | 'ready' | 'notFound' | 'forbidden' | 'failed'>('loading');
	let busy = $state(false);
	/** A deleted machine is read-only: nothing on it can be changed or brought back from here. */
	const access = $derived(
		principal?.status === 'deleted' ? { ...allowed, write: false, remove: false } : allowed
	);

	async function load(quiet = false) {
		if (!quiet) phase = 'loading';
		try {
			principal = await client.get(principalId);
			phase = 'ready';
		} catch (failure) {
			if (quiet) toast.error(t('mc.d.loadFailed'));
			principal = null;
			phase =
				failure instanceof ApiError && failure.status === 404
					? 'notFound'
					: failure instanceof ApiError && failure.status === 403
						? 'forbidden'
						: 'failed';
		}
	}

	$effect(() => {
		void principalId;
		untrack(() => void load());
	});

	const typeLabel = (type: string) =>
		(MACHINE_PRINCIPAL_TYPES as readonly string[]).includes(type)
			? t(`mc.type.${type as MachinePrincipalType}`)
			: type;

	function reachText(reach: MachineReach): string {
		if (reach.mode === 'all') return t('mc.reach.all');
		if (reach.mode === 'none') return t('mc.reach.none');
		return reach.tenantIds
			.map((id) => tenants.find((tenant) => tenant.id === id)?.name ?? id)
			.join(', ');
	}

	// ---- enable / disable
	let confirmDisable = $state(false);

	async function setEnabled(enable: boolean) {
		if (!principal) return;
		busy = true;
		try {
			if (enable) await client.enable(principal.id);
			else await client.disable(principal.id);
			confirmDisable = false;
			toast.success(t(enable ? 'mc.toast.enabled' : 'mc.toast.disabled'));
			await load(true);
		} catch (failure) {
			confirmDisable = false;
			toast.error(t(machineErrorKey(failure)));
		} finally {
			busy = false;
		}
	}

	// ---- settings (name; description and token lifetime folded)
	let editing = $state(false);
	let name = $state('');
	let description = $state('');
	let ttl = $state<number | null>(null);
	let ttlInvalid = $state(false);
	let settingsAdvanced = $state(false);
	let settingsError = $state('');
	let nameError = $state('');
	let ttlError = $state('');

	function openEdit() {
		if (!principal) return;
		name = principal.displayName;
		description = principal.description ?? '';
		ttl = principal.tokenTtlSeconds;
		ttlInvalid = false;
		settingsAdvanced = false;
		settingsError = nameError = ttlError = '';
		editing = true;
	}

	async function saveSettings() {
		if (!principal) return;
		nameError = ttlError = settingsError = '';
		if (!name.trim()) nameError = t('mc.new.nameRequired');
		if (tokenTtlProblem(ttl) || ttlInvalid) {
			ttlError = t('mc.new.ttlRange', { max: MACHINE_TOKEN_TTL_MAX });
			settingsAdvanced = true;
		}
		if (nameError || ttlError) return;
		busy = true;
		try {
			await client.update(principal.id, {
				displayName: name,
				description,
				tokenTtlSeconds: ttl as number
			});
			editing = false;
			toast.success(t('mc.toast.saved'));
			await load(true);
		} catch (failure) {
			settingsError = t(machineErrorKey(failure));
		} finally {
			busy = false;
		}
	}

	// ---- access (permissions and tenants; handing out access asks for step-up)
	let editingAccess = $state(false);
	let permissions = $state<string[]>([]);
	let permissionsInvalid = $state(false);
	let reach = $state<MachineReach>({ mode: 'none' });
	let accessError = $state('');
	let reachError = $state('');
	let accessKey = $state(0);

	function openAccess() {
		if (!principal) return;
		permissions = [...principal.permissions];
		permissionsInvalid = false;
		reach = principal.reach;
		accessError = reachError = '';
		accessKey += 1;
		editingAccess = true;
	}

	async function saveAccess() {
		if (!principal) return;
		accessError = reachError = '';
		if (reachProblem(reach)) reachError = t('mc.new.reachNoTenants');
		if (permissionsInvalid) accessError = t('mc.new.permissionsInvalid');
		if (reachError || accessError) return;
		busy = true;
		try {
			await client.update(principal.id, { permissions, reach });
			editingAccess = false;
			toast.success(t('mc.toast.saved'));
			await load(true);
		} catch (failure) {
			accessError = t(machineErrorKey(failure));
		} finally {
			busy = false;
		}
	}
</script>

<Page>
	<PageHeader title={principal?.displayName ?? t('nav.pa.machine')}>
		{#snippet back()}
			<BackLink href={listHref}>{t('mc.d.back')}</BackLink>
		{/snippet}
	</PageHeader>

	{#if phase === 'loading'}
		<LoadingState label={t('common.loading')} />
	{:else if phase === 'notFound'}
		<EmptyState icon="robot" title={t('mc.d.notFound')} />
	{:else if phase === 'forbidden'}
		<EmptyState icon="lock" title={t('mc.list.noAccess')} />
	{:else if phase === 'failed' || !principal}
		<EmptyState icon="warningCircle" title={t('mc.d.loadFailed')}>
			{#snippet action()}
				<Button size="sm" onclick={() => load()}>{t('common.retry')}</Button>
			{/snippet}
		</EmptyState>
	{:else}
		{#if principal.status === 'deleted'}
			<Callout tone="warning">{t('mc.d.deletedNote')}</Callout>
		{:else if principal.status !== 'active'}
			<Callout tone="warning">{t('mc.d.disabledNote')}</Callout>
		{/if}

		<Card title={t('mc.d.overview')}>
			{#snippet actions()}
				{#if access.write}
					<Button size="sm" icon="pencil" onclick={openEdit}>{t('mc.d.edit')}</Button>
				{/if}
				{#if principal?.status === 'deleted'}
					<!-- Nothing to offer. -->
				{:else if principal?.status === 'active'}
					{#if access.remove}
						<Button size="sm" onclick={() => (confirmDisable = true)}>{t('mc.d.disable')}</Button>
					{/if}
				{:else if access.write}
					<Button size="sm" variant="primary" loading={busy} onclick={() => setEnabled(true)}>
						{t('mc.d.enable')}
					</Button>
				{/if}
			{/snippet}
			<DetailList columns={2} ruled>
				<DetailItem label={t('mc.d.status')}>
					<Badge tone={principal.status === 'active' ? 'success' : 'neutral'} dot>
						{t(`mc.status.${principal.status}`)}
					</Badge>
				</DetailItem>
				<DetailItem label={t('mc.f.clientId')}><code>{principal.clientId}</code></DetailItem>
			</DetailList>
			<Disclosure title={t('mc.advanced')} description={t('mc.d.advancedDesc')}>
				<DetailList columns={2} ruled>
					<DetailItem label={t('mc.f.description')}>
						{principal.description ?? t('mc.d.none')}
					</DetailItem>
					<DetailItem label={t('mc.f.type')}>{typeLabel(principal.principalType)}</DetailItem>
					<DetailItem label={t('mc.f.ttl')}>
						{t('mc.d.ttlValue', { seconds: principal.tokenTtlSeconds })}
					</DetailItem>
					<DetailItem label={t('mc.d.updated')}>
						<DateTime value={principal.updatedAt} />
					</DetailItem>
				</DetailList>
			</Disclosure>
		</Card>

		<Card title={t('mc.d.access')} description={t('mc.d.accessDesc')}>
			{#snippet actions()}
				{#if access.write}
					<Button size="sm" icon="pencil" onclick={openAccess}>{t('mc.d.edit')}</Button>
				{/if}
			{/snippet}
			<DetailList columns={1} ruled>
				<DetailItem label={t('mc.f.permissions')}>
					{#if principal.permissions.length === 0}
						{t('mc.d.noPermissions')}
					{:else}
						<ul class="perms">
							{#each principal.permissions as permission (permission)}
								<li><code>{permission}</code></li>
							{/each}
						</ul>
					{/if}
				</DetailItem>
				<DetailItem label={t('mc.f.reach')}>{reachText(principal.reach)}</DetailItem>
			</DetailList>
		</Card>

		<MachineKeys {client} {principal} {access} onchanged={() => load(true)} />
	{/if}
</Page>

<FormDialog
	open={editing}
	title={t('mc.d.edit.title')}
	submitLabel={t('mc.d.edit.save')}
	{busy}
	error={settingsError}
	onsubmit={saveSettings}
	oncancel={() => (editing = false)}
>
	<TextField label={t('mc.f.name')} required maxlength={100} error={nameError} bind:value={name} />
	<Disclosure title={t('mc.advanced')} bind:open={settingsAdvanced} boxed>
		<TextArea label={t('mc.f.description')} maxlength={500} bind:value={description} />
		<NumberField
			label={t('mc.f.ttl')}
			unit={t('mc.f.ttlUnit')}
			min={1}
			max={MACHINE_TOKEN_TTL_MAX}
			hint={t('mc.f.ttlHint', { max: MACHINE_TOKEN_TTL_MAX })}
			error={ttlError}
			bind:value={ttl}
			bind:invalid={ttlInvalid}
		/>
	</Disclosure>
</FormDialog>

<FormDialog
	open={editingAccess}
	title={t('mc.d.access.title')}
	description={t('mc.d.access.note')}
	submitLabel={t('mc.d.edit.save')}
	{busy}
	error={accessError}
	onsubmit={saveAccess}
	oncancel={() => (editingAccess = false)}
>
	{#key accessKey}
		<MachineGrantFields
			bind:permissions
			bind:reach
			bind:invalid={permissionsInvalid}
			{tenants}
			{reachError}
		/>
	{/key}
</FormDialog>

<ConfirmDialog
	open={confirmDisable}
	title={t('mc.d.disable.title')}
	body={t('mc.d.disable.body')}
	confirmLabel={t('mc.d.disable')}
	tone="danger"
	{busy}
	onconfirm={() => setEnabled(false)}
	oncancel={() => (confirmDisable = false)}
/>

<style>
	.perms {
		display: grid;
		gap: 2px;
		margin: 0;
		padding: 0;
		list-style: none;
	}

	code {
		font-family: var(--font-mono);
		font-size: var(--fs-small);
	}
</style>
