<script lang="ts">
	import type {
		IdentityMappingStoryClient,
		SetChangePreview,
		StoryMappingContent,
		StoryMappingDraft,
		TestUser
	} from '#lib/api/identity-mapping.js';
	import { ApiError } from '#lib/api/api-error.js';
	import { t } from '#lib/i18n/i18n.svelte.js';
	import Callout from '#lib/ui/patterns/Callout.svelte';
	import ConfirmDialog from '#lib/ui/patterns/ConfirmDialog.svelte';
	import LoadingState from '#lib/ui/patterns/LoadingState.svelte';
	import type { Mapping, MappingField, MappingType } from '#lib/ui/patterns/mapping-model.js';
	import Button from '#lib/ui/primitives/Button.svelte';
	import { Draft } from '#lib/ui/save/draft.svelte.js';
	import { SaveStopped } from '#lib/ui/save/save-scope.js';
	import SaveScope, { type SaveControls } from '#lib/ui/save/SaveScope.svelte';
	import MappingSection from './MappingSection.svelte';
	import MappingSetPanel from './MappingSetPanel.svelte';
	import { toast } from '#lib/ui/toast/toast.svelte.js';

	/**
	 * MAP-05: before saving a set, what each app that uses it would receive. The draft is sent to
	 * the API's preview (the same content a save sends); it answers per app with the changes that
	 * reach its tokens given the scopes it is granted, and the ones held back. A test user's
	 * made-up values can be compared too; a real user's never are. The preview is optional: Save
	 * works without it, as decided for this screen.
	 */
	interface Props {
		onstate?: (state: { dirty: boolean; saving: boolean }) => void;
		onchanged?: () => void;
		client: IdentityMappingStoryClient;
		tenantId: string;
		setId: string;
		/** Start with these unsaved edits (stories, or a link from another screen). */
		edits?: StoryMappingDraft;
		/** Compare with this test user's values from the start. */
		sampleUserId?: string;
	}

	let { client, tenantId, setId, edits, onstate, onchanged, sampleUserId = '' }: Props = $props();

	interface Edit {
		mappings: Mapping[];
	}

	let content = $state<StoryMappingContent | null>(null);
	let users = $state<TestUser[]>([]);
	/** Apps using the set: listed in a tenant, counted per tenant for a platform set. */
	let usedByCount = $state(0);
	let loadError = $state(false);
	let draft = $state<Draft<Edit> | null>(null);
	let sample = $state('');
	let preview = $state<SetChangePreview | null>(null);
	let previewedDraft = $state('');
	let checking = $state(false);
	let actionError = $state('');
	let confirming = $state(false);
	/**
	 * The count of places to confirm, when a save was refused because it changed (the GET does
	 * not look in other tenants, so a platform set's count comes from the refusal).
	 */
	let confirmCount = $state<number | null>(null);
	/** Each load or check counts up; an answer for an older one is dropped. */
	let generation = 0;

	// The editor's transforms go to the API as they are, so a transform edit is a change too.
	const toMappings = (list: StoryMappingDraft['mappings']): Mapping[] =>
		list.map((m, index) => ({
			id: `m${index}`,
			target: m.target,
			sources: [...m.sources],
			steps: structuredClone((m.steps ?? []) as Mapping['steps'])
		}));
	const toDraft = (list: Mapping[]): StoryMappingDraft => ({
		mappings: list.map((m) => ({
			target: m.target,
			sources: [...m.sources],
			steps: structuredClone($state.snapshot(m.steps))
		}))
	});

	async function load() {
		const mine = ++generation;
		const ids = { tenantId, setId };
		loadError = false;
		content = null;
		draft = null;
		preview = null;
		checking = false;
		actionError = '';
		confirmCount = null;
		try {
			const [next, testUsers] = await Promise.all([
				client.setContent(ids.tenantId, ids.setId),
				client.testUsers(ids.tenantId).then((list) => list.test_users)
			]);
			// The preview of the saved content lists who uses the set, with no changes.
			const current = await client.previewSetChange(ids.tenantId, ids.setId, {
				mappings: next.mappings
			});
			if (mine !== generation) return;
			content = next;
			users = testUsers;
			usedByCount = current.tenants
				? current.tenants.reduce((total, row) => total + (row.apps_using ?? 0), 0)
				: current.apps.length;
			draft = new Draft<Edit>({ mappings: toMappings(next.mappings) });
			if (edits) draft.value.mappings = toMappings(edits.mappings);
			sample = sampleUserId;
		} catch {
			if (mine === generation) loadError = true;
		}
	}

	$effect(() => {
		void load();
	});

	const draftText = $derived(draft ? JSON.stringify(toDraft(draft.value.mappings)) : '');
	const stale = $derived(preview !== null && previewedDraft !== `${draftText}|${sample}`);
	const changed = $derived(preview?.apps.filter((a) => a.changes.length > 0) ?? []);

	const field = (f: { key: string; type: string }): MappingField => ({
		key: f.key,
		type: f.type as MappingType
	});

	async function check() {
		if (!draft) return;
		const mine = ++generation;
		const asked = `${draftText}|${sample}`;
		checking = true;
		actionError = '';
		try {
			const answer = await client.previewSetChange(
				tenantId,
				setId,
				toDraft(draft.value.mappings),
				sample || undefined
			);
			if (mine !== generation) return;
			preview = answer;
			previewedDraft = asked;
		} catch {
			if (mine === generation) actionError = t('mc.actionFailed');
		} finally {
			if (mine === generation) checking = false;
		}
	}

	/** Called by the scope's save: the count of places seen at load must still be the count. */
	async function save(value: Edit) {
		// A check still on its way is about the content before this save: drop it.
		++generation;
		checking = false;
		try {
			await client.saveSet(
				tenantId,
				setId,
				toDraft(value.mappings),
				confirmCount ?? content?.references?.count ?? null
			);
		} catch (error) {
			// Only a refusal for the count is answered by confirming again; any other refusal (the
			// places could not all be looked at, a change would break one) is shown as it is.
			const found =
				error instanceof ApiError && error.body.error === 'impact_confirmation_required'
					? (error.body.references as { count?: unknown } | undefined)?.count
					: undefined;
			if (typeof found === 'number') {
				// Ask again, with the count there is now; nothing was saved.
				confirmCount = found;
				confirming = true;
				throw new SaveStopped();
			}
			throw new Error(
				error instanceof ApiError && error.status === 409
					? t('mc.ch.saveRefused')
					: t('mc.actionFailed')
			);
		}
		preview = null;
		confirmCount = null;
		onchanged?.();
		toast.success(t('mc.ch.saved'));
	}

	async function confirmSave(controls: SaveControls) {
		confirming = false;
		await controls.save();
	}

	const setName = $derived(content?.set.display_name ?? setId);
</script>

<MappingSection>
	{#if loadError}
		<Callout tone="warning" live>
			{t('mc.loadFailed')}
			<Button variant="secondary" size="sm" onclick={load}>{t('mc.retry')}</Button>
		</Callout>
	{:else if !content || !draft}
		<LoadingState label={t('mc.loading')} />
	{:else}
		<SaveScope {draft} {onstate} onsave={save} bar={false}>
			{#snippet children(controls)}
				<div class="editor-actions">
					<Button
						disabled={!controls.dirty || checking}
						loading={controls.saving}
						onclick={() => (controls.invalid ? controls.save() : (confirming = true))}
					>
						{t('mc.ch.save')}
					</Button>
				</div>
				<MappingSetPanel
					title={setName}
					description={t('mc.ch.usedBy', { count: usedByCount })}
					sources={content!.attributes.map(field)}
					targets={content!.claims.map(field)}
					bind:mappings={draft!.value.mappings}
					{setId}
					{users}
					bind:sample
					{preview}
					{stale}
					{checking}
					{actionError}
					dirty={controls.dirty}
					oncheck={check}
				/>
				<ConfirmDialog
					open={confirming}
					title={t('mc.ch.saveConfirm.title', { set: setName })}
					body={(confirmCount === null ? '' : `${t('mc.ch.saveConflict')} `) +
						t('mc.ch.saveConfirm.body', {
							count: preview && !stale && !preview.tenants ? changed.length : usedByCount,
							refs: confirmCount ?? content!.references?.count ?? 0
						})}
					confirmLabel={t('mc.ch.save')}
					cancelLabel={t('mc.cancel')}
					busy={controls.saving}
					onconfirm={() => confirmSave(controls)}
					oncancel={() => (confirming = false)}
				/>
			{/snippet}
		</SaveScope>
	{/if}
</MappingSection>

<style>
	.editor-actions {
		display: flex;
		justify-content: flex-end;
	}
</style>
