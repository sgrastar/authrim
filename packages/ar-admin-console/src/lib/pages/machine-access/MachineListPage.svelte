<script lang="ts">
	import { untrack } from 'svelte';
	import type { MachineAccess } from '#lib/access/access.js';
	import { ApiError } from '#lib/api/api-error.js';
	import {
		MACHINE_PRINCIPAL_TYPES,
		MACHINE_TOKEN_TTL_DEFAULT,
		MACHINE_TOKEN_TTL_MAX,
		type MachineAccessClient,
		type MachinePrincipal,
		type MachinePrincipalType,
		type MachineReach
	} from '#lib/api/machine-access.js';
	import { t, type MessageKey } from '#lib/i18n/i18n.svelte.js';
	import Card from '#lib/ui/patterns/Card.svelte';
	import CellText from '#lib/ui/patterns/CellText.svelte';
	import DataTable from '#lib/ui/patterns/DataTable.svelte';
	import Disclosure from '#lib/ui/patterns/Disclosure.svelte';
	import EmptyState from '#lib/ui/patterns/EmptyState.svelte';
	import FormDialog from '#lib/ui/patterns/FormDialog.svelte';
	import LoadingState from '#lib/ui/patterns/LoadingState.svelte';
	import PageHeader from '#lib/ui/patterns/PageHeader.svelte';
	import Badge from '#lib/ui/primitives/Badge.svelte';
	import Button from '#lib/ui/primitives/Button.svelte';
	import NumberField from '#lib/ui/primitives/NumberField.svelte';
	import Select from '#lib/ui/primitives/Select.svelte';
	import TextArea from '#lib/ui/primitives/TextArea.svelte';
	import TextField from '#lib/ui/primitives/TextField.svelte';
	import Page from '#lib/ui/templates/Page.svelte';
	import DateTime from '#lib/ui/time/DateTime.svelte';
	import { toast } from '#lib/ui/toast/toast.svelte.js';
	import { machineErrorKey } from './machine-errors';
	import MachineGrantFields from './MachineGrantFields.svelte';
	import { CLIENT_ID_PATTERN, keyUsable, reachProblem, tokenTtlProblem } from './machine-model';

	/**
	 * Platform → Administrators → Machine access: the machines that sign in to the Admin API with
	 * their own key. A row opens its machine; "New" asks for the few things a machine needs, and
	 * keeps the rest (type, lifetime, description) under "Advanced settings".
	 */
	interface Props {
		client: MachineAccessClient;
		access: MachineAccess;
		tenants: ReadonlyArray<{ id: string; name: string }>;
		onopen: (principalId: string) => void;
	}

	let { client, access, tenants, onopen }: Props = $props();

	let principals = $state<MachinePrincipal[]>([]);
	let phase = $state<'loading' | 'ready' | 'forbidden' | 'failed'>('loading');

	let creating = $state(false);
	let busy = $state(false);
	let name = $state('');
	let clientId = $state('');
	let clientIdTouched = $state(false);
	let permissions = $state<string[]>([]);
	let permissionsInvalid = $state(false);
	let reach = $state<MachineReach>({ mode: 'none' });
	let advancedOpen = $state(false);
	let description = $state('');
	let typeValue = $state<string>('automation');
	let ttl = $state<number | null>(MACHINE_TOKEN_TTL_DEFAULT);
	let ttlInvalid = $state(false);
	let error = $state('');
	let nameError = $state('');
	let clientIdError = $state('');
	let reachError = $state('');
	let ttlError = $state('');
	let formKey = $state(0);

	async function load() {
		phase = 'loading';
		try {
			principals = await client.list();
			phase = 'ready';
		} catch (failure) {
			phase = failure instanceof ApiError && failure.status === 403 ? 'forbidden' : 'failed';
		}
	}

	$effect(() => {
		untrack(() => void load());
	});

	/** A client id suggested from the name until the admin types one. */
	const suggestId = (text: string) =>
		text
			.toLowerCase()
			.normalize('NFKD')
			.replace(/[^a-z0-9_-]+/g, '-')
			.replace(/^[-_]+|-+$/g, '')
			.slice(0, 64);

	function openCreate() {
		name = '';
		clientId = '';
		clientIdTouched = false;
		permissions = [];
		reach = { mode: 'none' };
		description = '';
		typeValue = 'automation';
		ttl = MACHINE_TOKEN_TTL_DEFAULT;
		ttlInvalid = false;
		permissionsInvalid = false;
		advancedOpen = false;
		error = nameError = clientIdError = reachError = ttlError = '';
		formKey += 1;
		creating = true;
	}

	async function create() {
		nameError = clientIdError = reachError = ttlError = error = '';
		if (!name.trim()) nameError = t('mc.new.nameRequired');
		if (!CLIENT_ID_PATTERN.test(clientId.trim())) clientIdError = t('mc.new.clientIdInvalid');
		if (reachProblem(reach)) reachError = t('mc.new.reachNoTenants');
		if (tokenTtlProblem(ttl) || ttlInvalid) {
			ttlError = t('mc.new.ttlRange', { max: MACHINE_TOKEN_TTL_MAX });
			// A problem inside the folded part opens it.
			advancedOpen = true;
		}
		if (permissionsInvalid) error = t('mc.new.permissionsInvalid');
		if (nameError || clientIdError || reachError || ttlError || permissionsInvalid) return;
		busy = true;
		try {
			const principal = await client.create({
				clientId,
				displayName: name,
				description,
				principalType: typeValue as MachinePrincipalType,
				tokenTtlSeconds: ttl as number,
				permissions,
				reach
			});
			creating = false;
			toast.success(t('mc.toast.created', { name: principal.displayName }));
			onopen(principal.id);
		} catch (failure) {
			const key: MessageKey = machineErrorKey(failure);
			error = t(key === 'mc.error.conflict' ? 'mc.new.clientIdTaken' : key);
		} finally {
			busy = false;
		}
	}

	const columns = $derived([
		{ key: 'name', label: t('mc.list.col.name') },
		{ key: 'type', label: t('mc.list.col.type'), width: '16%' },
		{ key: 'status', label: t('mc.list.col.status'), width: '12%' },
		{ key: 'keys', label: t('mc.list.col.keys'), width: '9%' },
		{ key: 'updated', label: t('mc.list.col.updated'), width: '18%' }
	]);

	const typeLabel = (type: string) =>
		(MACHINE_PRINCIPAL_TYPES as readonly string[]).includes(type)
			? t(`mc.type.${type as MachinePrincipalType}`)
			: type;
	const typeOptions = $derived(
		MACHINE_PRINCIPAL_TYPES.map((type) => ({ value: type, label: t(`mc.type.${type}`) }))
	);
</script>

<Page>
	<PageHeader title={t('nav.pa.machine')} description={t('mc.page.desc')}>
		{#snippet actions()}
			{#if access.write}
				<Button variant="primary" icon="plus" onclick={openCreate}>{t('mc.create')}</Button>
			{/if}
		{/snippet}
	</PageHeader>

	{#if phase === 'forbidden'}
		<EmptyState icon="lock" title={t('mc.list.noAccess')} />
	{:else}
		<Card title={t('mc.list.title')} flush>
			{#if phase === 'loading'}
				<LoadingState label={t('common.loading')} />
			{:else if phase === 'failed'}
				<EmptyState icon="warningCircle" title={t('mc.list.loadFailed')}>
					{#snippet action()}
						<Button size="sm" onclick={load}>{t('common.retry')}</Button>
					{/snippet}
				</EmptyState>
			{:else}
				<DataTable
					caption={t('mc.list.title')}
					{columns}
					rows={principals}
					rowKey={(row) => row.id}
					onrowopen={(row) => onopen(row.id)}
					rowOpenLabel={(row) => t('mc.list.open', { name: row.displayName })}
				>
					{#snippet cell(row, column)}
						{#if column.key === 'name'}
							<CellText title={row.displayName} description={row.clientId} />
						{:else if column.key === 'type'}
							{typeLabel(row.principalType)}
						{:else if column.key === 'status'}
							<Badge tone={row.status === 'active' ? 'success' : 'neutral'} dot>
								{t(`mc.status.${row.status}`)}
							</Badge>
						{:else if column.key === 'keys'}
							{row.keys.filter((key) => keyUsable(key)).length}
						{:else}
							<DateTime value={row.updatedAt} stacked />
						{/if}
					{/snippet}
					{#snippet empty()}
						<EmptyState
							icon="robot"
							title={t('mc.list.empty')}
							description={t('mc.list.emptyBody')}
						/>
					{/snippet}
				</DataTable>
			{/if}
		</Card>
	{/if}
</Page>

<FormDialog
	open={creating}
	title={t('mc.new.title')}
	description={t('mc.new.desc')}
	submitLabel={t('mc.new.submit')}
	{busy}
	{error}
	onsubmit={create}
	oncancel={() => (creating = false)}
>
	{#key formKey}
		<TextField
			label={t('mc.f.name')}
			required
			maxlength={100}
			error={nameError}
			bind:value={name}
			oninput={(event: Event) => {
				// From the field's own text: the bound `name` is updated after this handler runs.
				if (!clientIdTouched) clientId = suggestId((event.currentTarget as HTMLInputElement).value);
			}}
		/>
		<TextField
			label={t('mc.f.clientId')}
			required
			maxlength={128}
			hint={t('mc.f.clientIdHint')}
			error={clientIdError}
			bind:value={clientId}
			oninput={() => (clientIdTouched = true)}
		/>
		<MachineGrantFields
			bind:permissions
			bind:reach
			bind:invalid={permissionsInvalid}
			{tenants}
			{reachError}
		/>
		<Disclosure
			title={t('mc.advanced')}
			description={t('mc.new.advancedDesc')}
			bind:open={advancedOpen}
			boxed
		>
			<TextArea label={t('mc.f.description')} maxlength={500} bind:value={description} />
			<Select
				label={t('mc.f.type')}
				hint={t('mc.f.typeHint')}
				options={typeOptions}
				bind:value={typeValue}
			/>
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
	{/key}
</FormDialog>
