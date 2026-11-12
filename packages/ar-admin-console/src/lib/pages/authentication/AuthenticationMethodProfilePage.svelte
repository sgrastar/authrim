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
	import { keepsCopy, type ProfileLayer } from '#lib/api/profile-layer.js';
	import { t } from '#lib/i18n/i18n.svelte.js';
	import ConfirmDialog from '#lib/ui/patterns/ConfirmDialog.svelte';
	import ProfileLayerBadges from './ProfileLayerBadges.svelte';
	import ProfileLayerNotice from './ProfileLayerNotice.svelte';
	import { layerEditable } from './profile-layer-model';
	import EmptyState from '#lib/ui/patterns/EmptyState.svelte';
	import LoadingState from '#lib/ui/patterns/LoadingState.svelte';
	import PageHeader from '#lib/ui/patterns/PageHeader.svelte';
	import SaveBar from '#lib/ui/patterns/SaveBar.svelte';
	import TitleEditor from '#lib/ui/patterns/TitleEditor.svelte';
	import BackLink from '#lib/ui/primitives/BackLink.svelte';
	import Button from '#lib/ui/primitives/Button.svelte';
	import IconButton from '#lib/ui/primitives/IconButton.svelte';
	import Page from '#lib/ui/templates/Page.svelte';
	import { provideBusy } from '#lib/ui/busy/busy.js';
	import { toast } from '#lib/ui/toast/toast.svelte.js';
	import AuthenticationMethodFields from './AuthenticationMethodFields.svelte';
	import { withUnsetMethodsOn } from './authentication-method-fields';

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
	/** The platform layer: a platform profile, or Default with the platform's under it. */
	let layer = $state<ProfileLayer | null>(null);
	/** The profile whose own values the admin is about to remove (fixed when asked). */
	let revertTarget = $state<string | null>(null);
	const isPlatform = $derived(layer?.scope === 'platform');
	/** The admin may save, and the platform lets the tenant change it now. */
	const editable = $derived(canWrite && layerEditable(layer));
	let directoryStatus = $state<DirectoryPasswordStatus | null>(null);
	let saved = $state('');
	let busy = $state(false);
	let nameError = $state('');
	let editingName = $state(false);
	let nameBeforeEdit = '';
	let editNameButton = $state<HTMLButtonElement>();
	let nameEditor = $state<ReturnType<typeof TitleEditor>>();
	/** Opens the name editor if needed and takes the admin to its field. */
	async function focusNameEditor() {
		editingName = true;
		await tick();
		nameEditor?.focus();
	}
	let gone = false;
	let loads = 0;
	let directoryLoads = 0;
	let created: string | null = null;
	onDestroy(() => {
		gone = true;
	});

	// While a save or a revert is on its way the form takes no input: the answer replaces it.
	provideBusy(() => busy);

	const snapshot = (theName = name, theValues = values) =>
		JSON.stringify({ name: theName.trim(), values: theValues });
	$effect(() => {
		dirty = phase === 'ready' && snapshot() !== saved;
	});

	function setProfile(profile: AuthenticationMethodProfile) {
		name = profile.name;
		nameBeforeEdit = profile.name;
		values =
			profile.id === 'default'
				? structuredClone(profile.values)
				: withUnsetMethodsOn(profile.values);
		version = profile.version;
		isSystem = profile.is_system;
		layer = profile.layer;
		editingName = false;
		saved = snapshot();
		phase = 'ready';
	}

	async function load() {
		revertTarget = null;
		const turn = ++loads;
		const target = id;
		phase = 'loading';
		try {
			const profile = await client.get(target === 'new' ? 'default' : target);
			if (gone || turn !== loads || target !== id) return;
			if (target === 'new') {
				name = '';
				nameBeforeEdit = '';
				// Made from the Default's values: what it leaves unset is allowed, so it starts on.
				values = withUnsetMethodsOn(profile.values);
				version = 0;
				isSystem = false;
				layer = null;
				// A new profile opens with its name being entered (the editor focuses itself).
				editingName = canWrite;
				saved = snapshot();
				phase = 'ready';
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
	}
	function closeNameEditor() {
		editingName = false;
		void tick().then(() => editNameButton?.focus());
	}
	function discard() {
		if (busy || phase !== 'ready' || !saved) return;
		const original = JSON.parse(saved) as { name: string; values: AuthenticationMethodValues };
		name = original.name;
		nameBeforeEdit = original.name;
		values = structuredClone(original.values);
		nameError = '';
		editingName = isNew && canWrite;
		if (editingName) void focusNameEditor();
		else void tick().then(() => editNameButton?.focus());
	}

	function changeValue(key: string, checked: boolean) {
		values = { ...values, [key]: checked };
	}

	async function save() {
		if (busy || !editable || phase !== 'ready') return;
		if (!name.trim()) {
			// The editor opens (or stays open) and takes the admin to the field.
			nameError = t('am.page.nameRequired');
			await focusNameEditor();
			return;
		}
		// The name is there: an earlier problem with it (taken) is checked again by this save.
		nameError = '';
		// A name being typed is saved as it stands: the editor closes on it.
		if (editingName) {
			name = name.trim();
			closeNameEditor();
		}
		const target = id;
		const turn = loads;
		const input = { name: name.trim(), values: structuredClone($state.snapshot(values)) };
		const sent = snapshot(input.name, input.values);
		busy = true;
		try {
			const profile =
				target === 'new'
					? await client.create(input)
					: isPlatform
						? // A platform profile: the tenant's copy of it.
							await client.saveCopy(target, layer?.copyVersion ?? null, input.values)
						: await client.update(target, version, input);
			if (gone || turn !== loads || id !== target) return;
			version = profile.version;
			layer = profile.layer;
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
				// The form takes input again first: a field that is still disabled takes no focus.
				busy = false;
				await focusNameEditor();
				return;
			}
			if (error instanceof ApiError && error.code === 'profile_creation_not_allowed') {
				toast.error(t('pl.creationNotAllowed'));
				return;
			}
			// The platform set the tenant's values aside meanwhile: show what holds now.
			if (error instanceof ApiError && error.code === 'profile_not_editable') {
				toast.error(t('pl.notEditable'));
				void load();
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

	/** "Use the platform's values": removes the tenant's copy (or Default's own settings). */
	async function revert() {
		const target = revertTarget;
		revertTarget = null;
		// Only what was asked about, and only one that keeps values over the platform's.
		if (busy || !canWrite || phase !== 'ready' || target !== id) return;
		if (target !== 'default' && !keepsCopy(layer)) return;
		const turn = loads;
		busy = true;
		try {
			const profile = await client.revert(target);
			if (gone || turn !== loads || id !== target) return;
			setProfile(profile);
			toast.success(t('pl.revertSuccess'));
		} catch {
			if (gone || turn !== loads || id !== target) return;
			toast.error(t('pl.revertFailed'));
		} finally {
			busy = false;
		}
	}

	const title = $derived(name || (isNew ? t('am.page.new') : t('am.list.title')));
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
	<TitleEditor
		bind:this={nameEditor}
		value={name}
		label={t('am.page.name')}
		hint={t('am.page.nameHint')}
		requiredMessage={t('am.page.nameRequired')}
		error={nameError}
		onrequired={() => (nameError = t('am.page.nameRequired'))}
		maxlength={80}
		doneLabel={t('am.page.nameDone')}
		oninput={(typed) => {
			name = typed;
			nameError = '';
		}}
		ondone={(typed) => {
			name = typed;
			nameError = '';
			closeNameEditor();
		}}
		oncancel={() => {
			name = nameBeforeEdit;
			nameError = '';
			closeNameEditor();
		}}
	/>
{/snippet}

<Page>
	<PageHeader
		{title}
		description={t('am.page.description')}
		titleAction={canWrite && phase === 'ready' && !isSystem && !isPlatform && !editingName
			? nameAction
			: undefined}
		titleEditor={canWrite && phase === 'ready' && !isSystem && !isPlatform && editingName
			? nameForm
			: undefined}
	>
		{#snippet back()}<BackLink href={listHref}>{t('am.page.back')}</BackLink>{/snippet}
		{#snippet badges()}<ProfileLayerBadges {layer} size="md" />{/snippet}
	</PageHeader>
	{#if phase === 'loading'}
		<LoadingState label={t('common.loading')} />
	{:else if phase === 'ready'}
		<ProfileLayerNotice {layer} {canWrite} {busy} onrevert={() => (revertTarget = id)} />
		<AuthenticationMethodFields
			{values}
			canWrite={editable}
			{directoryStatus}
			onchange={changeValue}
		/>
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
	{#if editable && phase === 'ready'}
		<SaveBar {dirty} saving={busy} invalid={nameError !== ''} onsave={save} ondiscard={discard} />
	{/if}
</Page>

<ConfirmDialog
	open={revertTarget !== null && revertTarget === id}
	title={t('pl.revertTitle', { name })}
	body={t('pl.revertBody')}
	confirmLabel={t('pl.revert')}
	{busy}
	onconfirm={revert}
	oncancel={() => (revertTarget = null)}
/>
