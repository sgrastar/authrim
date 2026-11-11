<script lang="ts">
	import { onDestroy, tick, untrack } from 'svelte';
	import { ApiError } from '#lib/api/api-error.js';
	import type {
		ApplicationLauncher,
		LauncherOptions,
		LaunchersClient
	} from '#lib/api/launchers.js';
	import type { SamlServiceProviderOption } from '#lib/api/saml-providers.js';
	import { i18n, t, type MessageKey } from '#lib/i18n/i18n.svelte.js';
	import Callout from '#lib/ui/patterns/Callout.svelte';
	import Card from '#lib/ui/patterns/Card.svelte';
	import ConfirmDialog from '#lib/ui/patterns/ConfirmDialog.svelte';
	import EmptyState from '#lib/ui/patterns/EmptyState.svelte';
	import type { PickerItem } from '#lib/ui/patterns/EntityPicker.svelte';
	import LoadingState from '#lib/ui/patterns/LoadingState.svelte';
	import PageHeader from '#lib/ui/patterns/PageHeader.svelte';
	import TitleEditor from '#lib/ui/patterns/TitleEditor.svelte';
	import BackLink from '#lib/ui/primitives/BackLink.svelte';
	import Badge from '#lib/ui/primitives/Badge.svelte';
	import Button from '#lib/ui/primitives/Button.svelte';
	import IconButton from '#lib/ui/primitives/IconButton.svelte';
	import { Draft } from '#lib/ui/save/draft.svelte.js';
	import { SaveStopped } from '#lib/ui/save/save-scope.js';
	import SaveScope from '#lib/ui/save/SaveScope.svelte';
	import Page from '#lib/ui/templates/Page.svelte';
	import { toast } from '#lib/ui/toast/toast.svelte.js';
	import LauncherAppFields from './LauncherAppFields.svelte';
	import LauncherAudienceFields from './LauncherAudienceFields.svelte';
	import LauncherPreview from './LauncherPreview.svelte';
	import LauncherTileFields from './LauncherTileFields.svelte';
	import {
		LIMITS,
		categoriesOf,
		launcherInput,
		launcherProblems,
		launcherValue,
		newLauncherValue,
		nextSortOrder,
		type LauncherEditorValue,
		type ProblemField
	} from './launcher-model';

	/**
	 * A launcher's own page, also for making a new one (`id` "new"). The name is the title,
	 * edited in place with the pencil (a new launcher opens with it being named). Below the
	 * preview of its tile come what it opens, how its tile looks and who sees it; every change
	 * waits for Save. Fields that keep it from being saved say why once Save has been pressed
	 * (an address that is not HTTPS says so at once).
	 */
	interface Props {
		client: LaunchersClient;
		/** The tenant's SAML service providers (the enabled ones can be chosen). */
		loadSamlProviders: (signal?: AbortSignal) => Promise<SamlServiceProviderOption[]>;
		/** The launcher, or "new". */
		id: string;
		canWrite: boolean;
		listHref: string;
		/** A new launcher was saved: its page has an address now. */
		oncreated: (id: string) => void;
		/** The launcher was deleted: back to the list. */
		ondeleted: () => void;
	}

	let { client, loadSamlProviders, id, canWrite, listHref, oncreated, ondeleted }: Props = $props();

	const isNew = $derived(id === 'new');
	const readonly = $derived(!canWrite);

	let phase = $state<'loading' | 'ready' | 'missing' | 'forbidden' | 'failed'>('loading');
	let draft = $state(new Draft<LauncherEditorValue>(newLauncherValue()));
	let loaded = $state<ApplicationLauncher | null>(null);
	let options = $state<LauncherOptions>({
		oidc_clients: [],
		groups: [],
		attribute_keys: [],
		phosphor_icons: []
	});
	let samlProviders = $state<SamlServiceProviderOption[]>([]);
	let optionsFailed = $state(false);
	let categories = $state<string[]>([]);
	let sortOrder = 0;
	let attempted = $state(false);
	let editingName = $state(false);
	let nameButton = $state<HTMLButtonElement>();
	let deleting = $state(false);
	let deletingBusy = $state(false);

	let gone = false;
	onDestroy(() => (gone = true));
	/** The latest load: an earlier one answering late (the page moved on) is not taken. */
	let loads = 0;

	const groupItems = (launcherOptions: LauncherOptions) =>
		new Map<string, PickerItem>(
			launcherOptions.groups.map((group) => [
				group.id,
				{ value: group.id, label: group.display_name, description: group.group_key }
			])
		);
	const userItem = (user: { id: string; name: string; email: string }): PickerItem => ({
		value: user.id,
		label: user.name || user.email || user.id,
		description: user.name && user.email ? user.email : undefined
	});

	async function load() {
		const turn = ++loads;
		const target = id;
		const current = () => !gone && turn === loads && id === target;
		phase = 'loading';
		attempted = false;
		editingName = false;
		const controller = new AbortController();
		try {
			const [launcher, siblings, launcherOptions, providers] = await Promise.all([
				target === 'new' ? Promise.resolve(null) : client.get(target),
				client.list().catch(() => null),
				client.options().catch(() => null),
				loadSamlProviders(controller.signal).catch(() => null)
			]);
			if (!current()) return;
			optionsFailed = launcherOptions === null || providers === null;
			options = launcherOptions ?? options;
			samlProviders = (providers ?? []).filter((provider) => provider.enabled && provider.id);
			categories = categoriesOf(siblings ?? [], i18n.locale);
			const users =
				launcher?.visibility.mode === 'users' && launcher.visibility.user_ids.length > 0
					? await client.usersById(launcher.visibility.user_ids).catch(() => [])
					: [];
			if (!current()) return;
			loaded = launcher;
			sortOrder = launcher ? launcher.sort_order : siblings ? nextSortOrder(siblings) : 1_000_000;
			draft = new Draft(
				launcher
					? launcherValue(launcher, {
							users: new Map(users.map((user) => [user.id, userItem(user)])),
							groups: groupItems(options)
						})
					: newLauncherValue()
			);
			phase = 'ready';
			if (!launcher && canWrite) editingName = true;
		} catch (error) {
			if (!current()) return;
			phase =
				error instanceof ApiError && error.notFound
					? 'missing'
					: error instanceof ApiError && error.forbidden
						? 'forbidden'
						: 'failed';
		}
	}

	/** The launcher this page has just created: its address follows, and nothing is to load. */
	let created: string | null = null;
	$effect(() => {
		const current = id;
		untrack(() => {
			const justCreated = current === created;
			created = null;
			if (!justCreated) void load();
		});
	});

	const value = $derived(draft.value);
	const problems = $derived(
		launcherProblems(value, {
			clients: options.oidc_clients,
			samlProviderIds: new Set(samlProviders.map((provider) => provider.id)),
			optionsKnown: !optionsFailed
		})
	);
	/** Format problems show at once; missing values once Save has been pressed. */
	const FORMAT: ReadonlySet<MessageKey> = new Set([
		'ln.error.httpsOnly',
		'ln.error.relayStateTooLong',
		'ln.error.noInitiateLoginUri',
		'ln.error.clientUnavailable',
		'ln.error.spUnavailable'
	]);
	const shown = $derived(
		Object.fromEntries(
			Object.entries(problems).filter(([, key]) => attempted || FORMAT.has(key))
		) as Partial<Record<ProblemField, MessageKey>>
	);

	async function save(from: LauncherEditorValue) {
		const found = launcherProblems(from, {
			clients: options.oidc_clients,
			samlProviderIds: new Set(samlProviders.map((provider) => provider.id)),
			optionsKnown: !optionsFailed
		});
		const first = Object.entries(found)[0] as [ProblemField, MessageKey] | undefined;
		if (first) {
			attempted = true;
			toast.error(t(first[1]));
			if (first[0] === 'name') editingName = true;
			else {
				await tick();
				document.querySelector<HTMLElement>('[aria-invalid="true"]')?.focus();
			}
			throw new SaveStopped();
		}
		const visit = loads;
		const target = id;
		const clientUri =
			options.oidc_clients.find((entry) => entry.client_id === from.applicationId)
				?.initiate_login_uri ?? null;
		const input = launcherInput(from, isNew ? sortOrder : undefined, clientUri);
		try {
			const saved = isNew ? await client.create(input) : await client.update(target, input);
			if (gone || visit !== loads) throw new SaveStopped();
			loaded = saved;
			sortOrder = saved.sort_order;
			attempted = false;
			// The name being typed was saved with the rest: its editor closes on the saved name.
			editingName = false;
			// What the API stored (addresses come back normalised); the chosen names stay.
			const next = launcherValue(saved, {
				users: new Map(from.users.map((user) => [user.value, user])),
				groups: new Map(from.groups.map((group) => [group.value, group]))
			});
			// A tile colour turned off is not stored, but stays ready to be turned back on.
			if (!next.tileColored) next.tileBackground = from.tileBackground;
			draft.reset(next);
			if (isNew) {
				created = saved.id;
				toast.success(t('ln.editor.created'));
				oncreated(saved.id);
			} else toast.success(t('ln.editor.saved'));
		} catch (error) {
			if (error instanceof SaveStopped) throw error;
			if (error instanceof ApiError && error.notFound) phase = 'missing';
			toast.error(
				error instanceof ApiError && error.status === 400 && error.message
					? `${t('ln.editor.saveFailed')} ${error.message}`
					: t('ln.editor.saveFailed')
			);
			throw new SaveStopped();
		}
	}

	async function remove() {
		if (!loaded || deletingBusy) return;
		const target = loaded;
		deletingBusy = true;
		try {
			await client.remove(target.id);
		} catch (error) {
			if (!(error instanceof ApiError && error.notFound)) {
				// The dialog closes first: behind it the toast could not be read.
				deleting = false;
				toast.error(t('ln.list.deleteFailed'));
				return;
			}
		} finally {
			deletingBusy = false;
		}
		if (gone || id !== target.id) return;
		deleting = false;
		draft.discard();
		toast.success(t('ln.list.deleted', { name: target.name }));
		ondeleted();
	}

	/** The name when its editor opened: Cancel or Escape puts it back. */
	let nameBefore = '';
	$effect(() => {
		if (editingName) nameBefore = untrack(() => draft.value.name);
	});

	// Discard puts the saved values back as a new object: the name being edited goes with them, so
	// its editor closes (Cancel would otherwise bring back the discarded name).
	let seenDraft: Draft<LauncherEditorValue> | null = null;
	let seenValue: LauncherEditorValue | null = null;
	$effect(() => {
		const current = draft;
		const shown = current.value;
		untrack(() => {
			if (current === seenDraft && shown !== seenValue && editingName) editingName = false;
			seenDraft = current;
			seenValue = shown;
		});
	});

	function closeNameEditor() {
		editingName = false;
		void tick().then(() => nameButton?.focus());
	}

	async function searchUsers(query: string, signal: AbortSignal): Promise<PickerItem[]> {
		if (!query.trim()) return [];
		return (await client.searchUsers(query.trim(), signal)).map(userItem);
	}

	const title = $derived(value.name.trim() || t('ln.editor.new'));
	const loadMessage: Record<'missing' | 'forbidden' | 'failed', MessageKey> = {
		missing: 'ln.editor.notFound',
		forbidden: 'ln.editor.noAccess',
		failed: 'ln.editor.loadFailed'
	};
</script>

{#snippet nameAction()}
	<IconButton
		icon="pencil"
		size="sm"
		label={t('ln.editor.editName')}
		bind:element={nameButton}
		onclick={() => (editingName = true)}
	/>
{/snippet}

{#snippet nameEditor()}
	<TitleEditor
		value={draft.value.name}
		label={t('ln.editor.name')}
		hint={t('ln.editor.nameHint', { n: LIMITS.name })}
		requiredMessage={t('ln.error.nameRequired')}
		maxlength={LIMITS.name}
		doneLabel={t('ln.editor.nameDone')}
		ondone={(name) => {
			draft.value.name = name;
			closeNameEditor();
		}}
		oninput={(name) => (draft.value.name = name)}
		oncancel={() => {
			draft.value.name = nameBefore;
			closeNameEditor();
		}}
	/>
{/snippet}

<SaveScope {draft} onsave={save}>
	{#snippet children(controls)}
		<Page>
			<PageHeader
				{title}
				titleAction={phase === 'ready' && canWrite && !editingName ? nameAction : undefined}
				titleEditor={phase === 'ready' && canWrite && editingName ? nameEditor : undefined}
			>
				{#snippet back()}<BackLink href={listHref}>{t('ln.editor.back')}</BackLink>{/snippet}
				{#snippet badges()}
					{#if phase === 'ready'}
						{#if value.enabled}
							<Badge tone="success" dot>{t('ln.status.shown')}</Badge>
						{:else}
							<Badge dot>{t('ln.status.hidden')}</Badge>
						{/if}
					{/if}
				{/snippet}
				{#snippet actions()}
					{#if phase === 'ready' && loaded && canWrite}
						<Button
							variant="danger"
							icon="trash"
							disabled={controls.saving}
							onclick={() => (deleting = true)}>{t('ln.editor.delete')}</Button
						>
					{/if}
				{/snippet}
			</PageHeader>

			{#if phase === 'loading'}
				<LoadingState label={t('common.loading')} />
			{:else if phase !== 'ready'}
				<EmptyState
					icon={phase === 'forbidden' ? 'lock' : 'warningCircle'}
					title={t(loadMessage[phase])}
				>
					{#snippet action()}
						{#if phase === 'failed'}
							<Button size="sm" onclick={load}>{t('common.retry')}</Button>
						{:else if phase === 'missing'}
							<Button size="sm" href={listHref}>{t('ln.editor.back')}</Button>
						{/if}
					{/snippet}
				</EmptyState>
			{:else}
				{#if readonly}
					<Callout>{t('ln.editor.readOnly')}</Callout>
				{/if}
				{#if optionsFailed}
					<Callout tone="warning">{t('ln.editor.optionsFailed')}</Callout>
				{/if}

				<Card title={t('ln.card.preview')} info={t('ln.card.previewInfo')}>
					<LauncherPreview
						width={value.gridWidth}
						name={value.name.trim()}
						description={value.description.trim()}
						category={value.category.trim()}
						iconType={value.iconType}
						iconValue={value.iconType === 'image' ? value.imageUrl.trim() : value.iconName}
						iconColor={value.iconColor}
						background={value.backgroundColor}
						tileBackground={value.tileColored ? value.tileBackground : null}
						openInNewTab={value.openInNewTab}
						allowFavorite={value.allowFavorite}
						legacy={value.launchType === 'saml_idp_initiated'}
					/>
					{#if !value.enabled}
						<p class="editor__hidden">{t('ln.preview.hidden')}</p>
					{/if}
				</Card>

				<fieldset class="editor__form" disabled={readonly}>
					<LauncherAppFields
						bind:value={draft.value}
						clients={options.oidc_clients}
						{samlProviders}
						errors={shown}
						disabled={readonly}
					/>
					<LauncherTileFields
						bind:value={draft.value}
						icons={options.phosphor_icons}
						{categories}
						errors={shown}
						disabled={readonly}
					/>
					<LauncherAudienceFields
						bind:value={draft.value}
						groups={options.groups}
						{searchUsers}
						errors={shown}
						disabled={readonly}
					/>
				</fieldset>
			{/if}
		</Page>
	{/snippet}
</SaveScope>

<ConfirmDialog
	open={deleting}
	title={t('ln.list.deleteTitle', { name: loaded?.name ?? '' })}
	body={t('ln.list.deleteBody')}
	confirmLabel={t('ln.list.delete')}
	tone="danger"
	busy={deletingBusy}
	onconfirm={() => void remove()}
	oncancel={() => (deleting = false)}
/>

<style>
	.editor__form {
		display: grid;
		gap: var(--space-section);
		min-inline-size: 0;
		margin: 0;
		padding: 0;
		border: 0;
	}

	.editor__hidden {
		margin: var(--space-related) 0 0;
		color: var(--text-secondary);
		font-size: var(--fs-caption);
	}
</style>
