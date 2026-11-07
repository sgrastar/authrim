<script lang="ts">
	import { onDestroy, untrack } from 'svelte';
	import { ApiError } from '#lib/api/api-error.js';
	import type { LoginUiThemesClient } from '#lib/api/login-ui-themes.js';
	import { t, type MessageKey } from '#lib/i18n/i18n.svelte.js';
	import ConfirmDialog from '#lib/ui/patterns/ConfirmDialog.svelte';
	import EmptyState from '#lib/ui/patterns/EmptyState.svelte';
	import LoadingState from '#lib/ui/patterns/LoadingState.svelte';
	import PageHeader from '#lib/ui/patterns/PageHeader.svelte';
	import BackLink from '#lib/ui/primitives/BackLink.svelte';
	import Badge from '#lib/ui/primitives/Badge.svelte';
	import Button from '#lib/ui/primitives/Button.svelte';
	import TextField from '#lib/ui/primitives/TextField.svelte';
	import Page from '#lib/ui/templates/Page.svelte';
	import { toast } from '#lib/ui/toast/toast.svelte.js';
	import ThemeEditor from './ThemeEditor.svelte';
	import { newThemeDraft, type ThemeDraft } from './theme-draft';
	import { themeErrorKey } from './theme-errors';
	import {
		draftToValues,
		openStored,
		THEME_IMAGES,
		uploadThemeImages,
		valuesToDraft,
		type StoredTheme
	} from './theme-values';

	/**
	 * A theme's page: a new one (`id` "new") or a saved one. The console's header carries the way
	 * back to the list, the theme's name, whether it is applied, and Save and Apply; the theme's
	 * name is entered just under it, and the editor fills the rest. Images chosen in the editor are
	 * uploaded when the theme is saved. A theme with unsaved changes is not applied (save first),
	 * so that what is applied is what was saved.
	 */
	interface Props {
		client: LoginUiThemesClient;
		/** The theme, or "new". */
		id: string;
		canWrite: boolean;
		/** Uploads an image the editor holds as a file and answers its URL. */
		upload: (kind: string, file: File) => Promise<string>;
		/** The list's address (the way back). */
		listHref: string;
		/** A new theme was saved: it has an id now (the page's address follows). */
		oncreated: (id: string) => void;
		/** Changes not saved yet; the route asks before leaving. */
		dirty?: boolean;
	}

	let {
		client,
		id,
		canWrite,
		upload,
		listHref,
		oncreated,
		dirty = $bindable(false)
	}: Props = $props();

	const isNew = $derived(id === 'new');

	let phase = $state<'loading' | 'ready' | 'missing' | 'failed'>('loading');
	let name = $state('');
	let draft = $state<ThemeDraft>(newThemeDraft());
	/** The theme as stored (none for a new one): what the editor does not edit is saved as it was. */
	let stored: StoredTheme | undefined;
	let version = $state(0);
	/** The applied version of this theme, or null when another (or none) is applied. */
	let appliedVersion = $state<number | null>(null);
	let saved = $state('');
	let busy = $state(false);
	let nameError = $state<string>();
	let confirming = $state(false);

	/** What is compared to tell a change: the name and the draft as they would be saved. */
	const snapshotOf = (theName: string, theDraft: ThemeDraft) =>
		JSON.stringify({ name: theName.trim(), draft: { ...theDraft, language: '' } });
	const snapshot = () => snapshotOf(name, draft);

	// The page is gone (another theme, another tenant): a save under way stops where it is, so
	// that nothing it would still send goes to the tenant the console has moved on to.
	let gone = false;
	onDestroy(() => (gone = true));
	class Gone extends Error {}
	/**
	 * The visit of the page a save is for (the load it started after): the page moved to another
	 * theme, back again included, or is gone, and the save stops. It never resumes.
	 */
	let saving = { id: '', visit: -1 };
	const stillHere = () => {
		if (gone || id !== saving.id || loads !== saving.visit) throw new Gone();
	};

	$effect(() => {
		dirty = phase === 'ready' && snapshot() !== saved;
	});

	/** The latest load: an earlier one answering late (the page moved on) is not taken. */
	let loads = 0;

	async function load() {
		const turn = ++loads;
		const target = id;
		const current = () => !gone && turn === loads && id === target;
		phase = 'loading';
		if (isNew) {
			name = '';
			draft = newThemeDraft();
			stored = undefined;
			version = 0;
			appliedVersion = null;
			saved = snapshot();
			phase = 'ready';
			return;
		}
		try {
			const { theme, active } = await client.get(target);
			let applied: number | null = null;
			if (active) {
				const list = await client.list();
				applied = list.active?.theme_id === target ? list.active.version : null;
			}
			if (!current()) return;
			name = theme.name;
			draft = valuesToDraft(theme.values);
			stored = openStored(theme.values);
			version = theme.version;
			appliedVersion = applied;
			saved = snapshot();
			phase = 'ready';
		} catch (error) {
			if (!current()) return;
			phase = error instanceof ApiError && error.status === 404 ? 'missing' : 'failed';
		}
	}

	/** The theme this page has just created: its address follows, and nothing is to load. */
	let created: string | null = null;

	// Loaded again only when the theme changes: what load() reads and writes is not followed. A
	// new theme that was just saved keeps its page as it is (changes made while it was saved too).
	$effect(() => {
		const current = id;
		untrack(() => {
			const justCreated = current === created;
			created = null;
			if (!justCreated) void load();
		});
	});

	/** Put the uploaded images' URLs in the draft, where the admin has not chosen again since. */
	function takeUploads(sent: ThemeDraft, uploaded: ThemeDraft) {
		for (const image of THEME_IMAGES) {
			if (draft[image.field] === sent[image.field]) draft[image.field] = uploaded[image.field];
		}
	}

	async function save() {
		const trimmed = name.trim();
		nameError = trimmed ? undefined : t('th.page.nameRequired');
		if (!trimmed) return;
		busy = true;
		saving = { id, visit: loads };
		// The theme as it was when the save started: what it is saved over, and its version.
		const over = stored;
		const from = version;
		// What is saved is the draft as it is now; changes made while it is saved stay unsaved.
		// Its nested parts are copied: edits made after the save must not change what it compares with.
		const sent: ThemeDraft = {
			...draft,
			texts: $state.snapshot(draft.texts),
			backgroundFilters: $state.snapshot(draft.backgroundFilters)
		};
		try {
			let uploaded: ThemeDraft;
			try {
				uploaded = await uploadThemeImages(sent, async (kind, file) => {
					stillHere();
					return upload(kind, file);
				});
			} catch (error) {
				if (error instanceof Gone) return;
				toast.error(t('th.error.upload'));
				return;
			}
			stillHere();
			const input = { name: trimmed, values: draftToValues(uploaded, over) };
			const theme = isNew
				? await client.create(input)
				: await client.update(saving.id, from, input);
			stillHere();
			takeUploads(sent, uploaded);
			// What was saved is what the theme now is: the next save compares with it.
			stored = { values: theme.values, opened: uploaded };
			version = theme.version;
			saved = snapshotOf(trimmed, uploaded);
			if (name.trim() === trimmed) name = theme.name;
			if (isNew) {
				created = theme.id;
				toast.success(t('th.toast.created'));
				oncreated(theme.id);
			} else {
				toast.success(t('th.toast.saved'));
			}
		} catch (error) {
			if (error instanceof Gone) return;
			const key = themeErrorKey(error, 'th.error.save');
			if (key === 'th.error.nameTaken') nameError = t(key);
			else toast.error(t(key));
		} finally {
			busy = false;
		}
	}

	async function apply() {
		busy = true;
		const target = id;
		try {
			const active = await client.apply(target, version);
			if (gone || id !== target) return;
			appliedVersion = active.version;
			confirming = false;
			toast.success(t('th.toast.applied', { name: name.trim() }));
		} catch (error) {
			toast.error(t(themeErrorKey(error, 'th.error.apply')));
		} finally {
			busy = false;
		}
	}

	const title = $derived(name.trim() || t('th.page.new'));
	const applied = $derived(appliedVersion !== null);
	/** Applied, and saved again since: the screens still show the version applied. */
	const pending = $derived(appliedVersion !== null && appliedVersion < version);
	const loadMessage: Record<'missing' | 'failed', MessageKey> = {
		missing: 'th.page.notFound',
		failed: 'th.page.loadFailed'
	};
</script>

<Page>
	<PageHeader {title}>
		{#snippet back()}
			<BackLink href={listHref}>{t('th.page.back')}</BackLink>
		{/snippet}
		{#snippet badges()}
			{#if applied}
				<Badge tone="success" dot>{t('th.list.active')}</Badge>
				{#if pending}<Badge tone="warning">{t('th.list.pending')}</Badge>{/if}
			{/if}
		{/snippet}
		{#snippet actions()}
			{#if canWrite && phase === 'ready'}
				{#if !isNew}
					<Button
						variant="secondary"
						disabled={busy || dirty}
						title={dirty ? t('th.page.applyUnsaved') : undefined}
						onclick={() => (confirming = true)}>{t('th.action.apply')}</Button
					>
				{/if}
				<Button
					variant="primary"
					loading={busy}
					disabled={!dirty && !isNew}
					attention={dirty}
					onclick={save}
				>
					{t('th.page.save')}
				</Button>
			{/if}
		{/snippet}
	</PageHeader>

	{#if phase === 'loading'}
		<LoadingState label={t('common.loading')} />
	{:else if phase === 'missing' || phase === 'failed'}
		<EmptyState icon="warningCircle" title={t(loadMessage[phase])}>
			{#snippet action()}
				{#if phase === 'failed'}
					<Button size="sm" onclick={load}>{t('common.retry')}</Button>
				{:else}
					<Button size="sm" href={listHref}>{t('th.page.back')}</Button>
				{/if}
			{/snippet}
		</EmptyState>
	{:else}
		<div class="name">
			<TextField
				label={t('th.page.name')}
				hint={t('th.page.nameHint')}
				bind:value={name}
				maxlength={80}
				counter
				required
				readonly={!canWrite}
				error={nameError}
				oninput={() => (nameError = undefined)}
			/>
		</div>
		<ThemeEditor bind:draft />
	{/if}
</Page>

<ConfirmDialog
	open={confirming}
	title={t('th.apply.title', { name: name.trim() })}
	body={t('th.apply.body')}
	confirmLabel={t('th.apply.confirm')}
	{busy}
	onconfirm={apply}
	oncancel={() => (confirming = false)}
/>

<style>
	/* The name is one short line: it does not need the page's width. */
	.name {
		max-width: 480px;
	}
</style>
