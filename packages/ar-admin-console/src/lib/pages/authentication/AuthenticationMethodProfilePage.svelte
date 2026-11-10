<script lang="ts">
	import { onDestroy, tick, untrack } from 'svelte';
	import { ApiError } from '#lib/api/api-error.js';
	import type {
		AuthenticationMethodProfile,
		AuthenticationMethodProfilesClient,
		AuthenticationMethodValues
	} from '#lib/api/authentication-method-profiles.js';
	import type {
		DirectoryPasswordStatus,
		DirectoryPasswordStatusClient
	} from '#lib/api/directory-password-status.js';
	import { t } from '#lib/i18n/i18n.svelte.js';
	import EmptyState from '#lib/ui/patterns/EmptyState.svelte';
	import LoadingState from '#lib/ui/patterns/LoadingState.svelte';
	import PageHeader from '#lib/ui/patterns/PageHeader.svelte';
	import BackLink from '#lib/ui/primitives/BackLink.svelte';
	import Button from '#lib/ui/primitives/Button.svelte';
	import IconButton from '#lib/ui/primitives/IconButton.svelte';
	import Page from '#lib/ui/templates/Page.svelte';
	import { toast } from '#lib/ui/toast/toast.svelte.js';
	import AuthenticationMethodFields from './AuthenticationMethodFields.svelte';

	interface Props {
		client: AuthenticationMethodProfilesClient;
		directoryStatusClient: DirectoryPasswordStatusClient;
		tenantId: string | null;
		id: string;
		canWrite: boolean;
		listHref: string;
		oncreated: (id: string) => void;
		dirty?: boolean;
	}
	let {
		client,
		directoryStatusClient,
		tenantId,
		id,
		canWrite,
		listHref,
		oncreated,
		dirty = $bindable(false)
	}: Props = $props();
	const isNew = $derived(id === 'new');
	let phase = $state<'loading' | 'ready' | 'missing' | 'forbidden' | 'failed'>('loading');
	let name = $state('');
	let values = $state<AuthenticationMethodValues>({});
	let version = $state<number | string>(0);
	let isSystem = $state(false);
	let directoryStatus = $state<DirectoryPasswordStatus | null>(null);
	let saved = $state('');
	let busy = $state(false);
	let nameError = $state('');
	let editingName = $state(false);
	let nameBeforeEdit = '';
	let nameInput = $state<HTMLInputElement>();
	let editNameButton = $state<HTMLButtonElement>();
	let gone = false;
	let loads = 0;
	let directoryLoads = 0;
	let created: string | null = null;
	onDestroy(() => {
		gone = true;
	});

	const snapshot = (theName = name, theValues = values) =>
		JSON.stringify({ name: theName.trim(), values: theValues });
	$effect(() => {
		dirty = phase === 'ready' && snapshot() !== saved;
	});

	function setProfile(profile: AuthenticationMethodProfile) {
		name = profile.name;
		nameBeforeEdit = profile.name;
		values = structuredClone(profile.values);
		version = profile.version;
		isSystem = profile.is_system;
		editingName = false;
		saved = snapshot();
		phase = 'ready';
	}

	async function load() {
		const turn = ++loads;
		const target = id;
		phase = 'loading';
		try {
			const profile = await client.get(target === 'new' ? 'default' : target);
			if (gone || turn !== loads || target !== id) return;
			if (target === 'new') {
				name = '';
				nameBeforeEdit = '';
				values = structuredClone(profile.values);
				version = 0;
				isSystem = false;
				editingName = canWrite;
				saved = snapshot();
				phase = 'ready';
				if (editingName) void tick().then(() => nameInput?.focus());
			} else setProfile(profile);
		} catch (error) {
			if (gone || turn !== loads || target !== id) return;
			phase =
				error instanceof ApiError && error.notFound
					? 'missing'
					: error instanceof ApiError && error.forbidden
						? 'forbidden'
						: 'failed';
		}
	}
	$effect(() => {
		const current = id;
		untrack(() => {
			const justCreated = current === created;
			created = null;
			if (!justCreated) void load();
		});
	});

	async function loadDirectoryStatus(currentTenantId: string | null) {
		const turn = ++directoryLoads;
		directoryStatus = null;
		if (!currentTenantId) return;
		try {
			const status = await directoryStatusClient.get(currentTenantId);
			if (gone || turn !== directoryLoads) return;
			directoryStatus = status;
		} catch {
			// Directory Authentication has its own read permission. An unavailable status must not
			// be presented as "not configured".
			if (gone || turn !== directoryLoads) return;
			directoryStatus = null;
		}
	}
	$effect(() => {
		const currentTenantId = tenantId;
		untrack(() => void loadDirectoryStatus(currentTenantId));
	});

	function beginNameEdit() {
		nameBeforeEdit = name;
		nameError = '';
		editingName = true;
		void tick().then(() => {
			nameInput?.focus();
			nameInput?.select();
		});
	}
	function finishNameEdit(): boolean {
		const trimmed = name.trim();
		if (!trimmed) {
			nameError = t('am.page.nameRequired');
			nameInput?.focus();
			return false;
		}
		name = trimmed;
		nameError = '';
		editingName = false;
		void tick().then(() => editNameButton?.focus());
		return true;
	}
	function cancelNameEdit() {
		name = nameBeforeEdit;
		nameError = '';
		editingName = false;
		void tick().then(() => editNameButton?.focus());
	}

	function changeValue(key: string, checked: boolean) {
		values = { ...values, [key]: checked };
	}

	async function save() {
		if (busy || !canWrite || phase !== 'ready') return;
		if (!name.trim()) {
			nameError = t('am.page.nameRequired');
			editingName = true;
			await tick();
			nameInput?.focus();
			return;
		}
		if (editingName && !finishNameEdit()) return;
		const target = id;
		const turn = loads;
		const input = { name: name.trim(), values: structuredClone($state.snapshot(values)) };
		const sent = snapshot(input.name, input.values);
		busy = true;
		try {
			const profile =
				target === 'new' ? await client.create(input) : await client.update(target, version, input);
			if (gone || turn !== loads || id !== target) return;
			version = profile.version;
			saved = sent;
			toast.success(t('am.page.saved'));
			if (target === 'new') {
				created = profile.id;
				oncreated(profile.id);
			}
		} catch (error) {
			if (gone || turn !== loads || id !== target) return;
			if (error instanceof ApiError && error.body.error === 'profile_name_taken') {
				nameError = t('am.page.nameTaken');
				editingName = true;
				await tick();
				nameInput?.focus();
				return;
			}
			toast.error(
				error instanceof ApiError && error.status === 409
					? t('am.page.conflict')
					: t('am.page.saveFailed')
			);
		} finally {
			busy = false;
		}
	}

	const title = $derived(isNew ? t('am.page.new') : name || t('am.list.title'));
</script>

{#snippet nameAction()}
	<IconButton
		icon="pencil"
		size="sm"
		label={t('am.page.editName')}
		bind:element={editNameButton}
		onclick={beginNameEdit}
	/>
{/snippet}

{#snippet nameForm()}
	<form
		class="name-editor"
		onsubmit={(event) => {
			event.preventDefault();
			finishNameEdit();
		}}
	>
		<div class="name-editor__row">
			<label class="sr-only" for="auth-method-profile-name">{t('am.page.name')}</label>
			<input
				id="auth-method-profile-name"
				bind:this={nameInput}
				bind:value={name}
				maxlength="80"
				aria-required="true"
				aria-invalid={nameError ? 'true' : undefined}
				aria-describedby={nameError ? 'auth-method-name-error' : 'auth-method-name-hint'}
				oninput={() => (nameError = '')}
				onkeydown={(event) => {
					if (event.key === 'Escape') {
						event.preventDefault();
						cancelNameEdit();
					}
				}}
			/>
			<Button type="submit" variant="primary" size="sm">{t('am.page.nameDone')}</Button>
			<Button variant="ghost" size="sm" onclick={cancelNameEdit}>{t('common.cancel')}</Button>
		</div>
		{#if nameError}<p id="auth-method-name-error" class="name-editor__error" role="alert">
				{nameError}
			</p>
		{:else}<p id="auth-method-name-hint" class="name-editor__hint">{t('am.page.nameHint')}</p>{/if}
	</form>
{/snippet}

<Page>
	<PageHeader
		{title}
		description={t('am.page.description')}
		titleAction={canWrite && phase === 'ready' && !isSystem && !editingName
			? nameAction
			: undefined}
		titleEditor={canWrite && phase === 'ready' && !isSystem && editingName ? nameForm : undefined}
	>
		{#snippet back()}<BackLink href={listHref}>{t('am.page.back')}</BackLink>{/snippet}
		{#snippet actions()}
			{#if canWrite && phase === 'ready'}
				<Button
					variant="primary"
					loading={busy}
					attention={dirty}
					disabled={!dirty && !isNew}
					onclick={save}>{t('am.page.save')}</Button
				>
			{/if}
		{/snippet}
	</PageHeader>
	{#if phase === 'loading'}
		<LoadingState label={t('common.loading')} />
	{:else if phase === 'ready'}
		<AuthenticationMethodFields {values} {canWrite} {directoryStatus} onchange={changeValue} />
	{:else}
		<EmptyState
			icon={phase === 'forbidden' ? 'lock' : 'warningCircle'}
			title={t(
				phase === 'missing'
					? 'am.page.notFound'
					: phase === 'forbidden'
						? 'am.page.noAccess'
						: 'am.page.loadFailed'
			)}
		>
			{#snippet action()}{#if phase === 'failed'}<Button size="sm" onclick={load}
						>{t('common.retry')}</Button
					>{/if}{/snippet}
		</EmptyState>
	{/if}
</Page>

<style>
	.name-editor {
		width: min(100%, 520px);
	}
	.name-editor__row {
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		gap: 6px;
	}
	.name-editor input {
		flex: 1 1 210px;
		min-width: 0;
		height: calc(var(--fs-page-title) * 1.6);
		padding: 0 10px;
		border: 1px solid var(--border-strong);
		border-radius: var(--radius-control);
		background: var(--bg-input);
		color: var(--text-primary);
		font: inherit;
	}
	.name-editor__hint,
	.name-editor__error {
		margin: 5px 0 0;
		font-size: var(--fs-small);
	}
	.name-editor__hint {
		color: var(--text-muted);
	}
	.name-editor__error {
		color: var(--danger);
	}
</style>
