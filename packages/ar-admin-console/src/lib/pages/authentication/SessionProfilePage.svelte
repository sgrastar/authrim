<script lang="ts">
	import { onDestroy, tick, untrack } from 'svelte';
	import { ApiError } from '#lib/api/api-error.js';
	import type {
		SessionProfile,
		SessionProfilesClient,
		SessionProfileValues
	} from '#lib/api/session-profiles.js';
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
	import BackLink from '#lib/ui/primitives/BackLink.svelte';
	import Button from '#lib/ui/primitives/Button.svelte';
	import IconButton from '#lib/ui/primitives/IconButton.svelte';
	import Page from '#lib/ui/templates/Page.svelte';
	import { provideBusy } from '#lib/ui/busy/busy.js';
	import { toast } from '#lib/ui/toast/toast.svelte.js';
	import SessionProfileFields from './SessionProfileFields.svelte';

	interface Props {
		client: SessionProfilesClient;
		id: string;
		canWrite: boolean;
		listHref: string;
		oncreated: (id: string) => void;
		dirty?: boolean;
	}
	let { client, id, canWrite, listHref, oncreated, dirty = $bindable(false) }: Props = $props();
	const isNew = $derived(id === 'new');
	let phase = $state<'loading' | 'ready' | 'missing' | 'forbidden' | 'failed'>('loading');
	let name = $state('');
	let values = $state<SessionProfileValues>({});
	let version = $state<number | string>(0);
	let isSystem = $state(false);
	/** The platform layer: a platform profile, or Default with the platform's under it. */
	let layer = $state<ProfileLayer | null>(null);
	/** The profile whose own values the admin is about to remove (fixed when asked). */
	let revertTarget = $state<string | null>(null);
	const isPlatform = $derived(layer?.scope === 'platform');
	/** The admin may save, and the platform lets the tenant change it now. */
	const editable = $derived(canWrite && layerEditable(layer));
	/** A setting cannot be saved as it is (its field says why). */
	let fieldsInvalid = $state(false);
	/** Changed when the fields start over (loaded, saved, discarded): their own errors go too. */
	let revision = $state(0);
	let saved = $state('');
	let busy = $state(false);
	// While a save is on its way nothing can be changed: the answer replaces the form, and an edit
	// made meanwhile would be lost while it looked saved.
	provideBusy(() => busy);
	let nameError = $state('');
	let editingName = $state(false);
	let nameBeforeEdit = '';
	let nameInput = $state<HTMLInputElement>();
	let editNameButton = $state<HTMLButtonElement>();
	let gone = false;
	let loads = 0;
	let created: string | null = null;
	onDestroy(() => {
		gone = true;
	});

	const snapshot = (theName = name, theValues = values) =>
		JSON.stringify({ name: theName.trim(), values: theValues });
	$effect(() => {
		dirty = phase === 'ready' && snapshot() !== saved;
	});

	function setProfile(profile: SessionProfile) {
		name = profile.name;
		nameBeforeEdit = profile.name;
		values = structuredClone(profile.values);
		version = profile.version;
		isSystem = profile.is_system;
		layer = profile.layer;
		editingName = false;
		revision++;
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
				values = structuredClone(profile.values);
				version = 0;
				isSystem = false;
				layer = null;
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
			nameError = t('sp.page.nameRequired');
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
	function discard() {
		if (busy || phase !== 'ready' || !saved) return;
		const original = JSON.parse(saved) as { name: string; values: SessionProfileValues };
		name = original.name;
		nameBeforeEdit = original.name;
		values = structuredClone(original.values);
		nameError = '';
		revision++;
		editingName = isNew && canWrite;
		void tick().then(() => (editingName ? nameInput : editNameButton)?.focus());
	}

	function changeValue(key: string, value: unknown) {
		const next = { ...values };
		if (value === undefined) delete next[key];
		else next[key] = value;
		values = next;
	}

	async function save() {
		if (busy || !editable || phase !== 'ready') return;
		if (!name.trim()) {
			nameError = t('sp.page.nameRequired');
			editingName = true;
			await tick();
			nameInput?.focus();
			return;
		}
		if (editingName && !finishNameEdit()) return;
		if (fieldsInvalid) return;
		const target = id;
		const turn = loads;
		const input = { name: name.trim(), values: structuredClone($state.snapshot(values)) };
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
			// What was saved, as the API has it now (Default: the tenant's settings after the change).
			setProfile(profile);
			toast.success(t('sp.page.saved'));
			if (target === 'new') {
				created = profile.id;
				oncreated(profile.id);
			}
		} catch (error) {
			if (gone || turn !== loads || id !== target) return;
			if (error instanceof ApiError && error.body.error === 'profile_name_taken') {
				nameError = t('sp.page.nameTaken');
				editingName = true;
				await tick();
				nameInput?.focus();
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
					? t('sp.page.conflict')
					: t('sp.page.saveFailed')
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

	const title = $derived(name || (isNew ? t('sp.page.new') : t('sp.list.title')));
</script>

{#snippet nameAction()}
	<IconButton
		icon="pencil"
		size="sm"
		label={t('sp.page.editName')}
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
			<label class="sr-only" for="session-profile-name">{t('sp.page.name')}</label>
			<input
				id="session-profile-name"
				bind:this={nameInput}
				bind:value={name}
				disabled={busy}
				maxlength="80"
				aria-required="true"
				aria-invalid={nameError ? 'true' : undefined}
				aria-describedby={nameError ? 'session-profile-name-error' : 'session-profile-name-hint'}
				oninput={() => (nameError = '')}
				onkeydown={(event) => {
					if (event.key === 'Escape') {
						event.preventDefault();
						cancelNameEdit();
					}
				}}
			/>
			<Button type="submit" variant="primary" size="sm">{t('sp.page.nameDone')}</Button>
			<Button variant="ghost" size="sm" onclick={cancelNameEdit}>{t('common.cancel')}</Button>
		</div>
		{#if nameError}<p id="session-profile-name-error" class="name-editor__error" role="alert">
				{nameError}
			</p>
		{:else}<p id="session-profile-name-hint" class="name-editor__hint">
				{t('sp.page.nameHint')}
			</p>{/if}
	</form>
{/snippet}

<Page>
	<PageHeader
		{title}
		description={t('sp.page.description')}
		titleAction={canWrite && phase === 'ready' && !isSystem && !isPlatform && !editingName
			? nameAction
			: undefined}
		titleEditor={canWrite && phase === 'ready' && !isSystem && !isPlatform && editingName
			? nameForm
			: undefined}
	>
		{#snippet back()}<BackLink href={listHref}>{t('sp.page.back')}</BackLink>{/snippet}
		{#snippet badges()}<ProfileLayerBadges {layer} size="md" />{/snippet}
	</PageHeader>
	{#if phase === 'loading'}
		<LoadingState label={t('common.loading')} />
	{:else if phase === 'ready'}
		<ProfileLayerNotice {layer} {canWrite} {busy} onrevert={() => (revertTarget = id)} />
		{#key revision}
			<SessionProfileFields
				{values}
				canWrite={editable}
				isDefault={isSystem}
				onchange={changeValue}
				bind:invalid={fieldsInvalid}
			/>
		{/key}
	{:else}
		<EmptyState
			icon={phase === 'forbidden' ? 'lock' : 'warningCircle'}
			title={t(
				phase === 'missing'
					? 'sp.page.notFound'
					: phase === 'forbidden'
						? 'sp.page.noAccess'
						: 'sp.page.loadFailed'
			)}
		>
			{#snippet action()}{#if phase === 'failed'}<Button size="sm" onclick={load}
						>{t('common.retry')}</Button
					>{/if}{/snippet}
		</EmptyState>
	{/if}
	{#if editable && phase === 'ready'}
		<SaveBar
			{dirty}
			saving={busy}
			invalid={nameError !== '' || fieldsInvalid}
			onsave={save}
			ondiscard={discard}
		/>
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
