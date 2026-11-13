<script lang="ts">
	import { onDestroy, untrack } from 'svelte';
	import { ApiError } from '#lib/api/api-error.js';
	import type {
		ConsentLocalization,
		ConsentStatement,
		ConsentStatementsClient,
		ConsentStatementUsage,
		ConsentVersion
	} from '#lib/api/consent-statements.js';
	import { i18n, t, type MessageKey } from '#lib/i18n/i18n.svelte.js';
	import Callout from '#lib/ui/patterns/Callout.svelte';
	import Card from '#lib/ui/patterns/Card.svelte';
	import ConfirmDialog from '#lib/ui/patterns/ConfirmDialog.svelte';
	import EmptyState from '#lib/ui/patterns/EmptyState.svelte';
	import FormDialog from '#lib/ui/patterns/FormDialog.svelte';
	import LoadingState from '#lib/ui/patterns/LoadingState.svelte';
	import PageHeader from '#lib/ui/patterns/PageHeader.svelte';
	import BackLink from '#lib/ui/primitives/BackLink.svelte';
	import Badge from '#lib/ui/primitives/Badge.svelte';
	import Button from '#lib/ui/primitives/Button.svelte';
	import Checkbox from '#lib/ui/primitives/Checkbox.svelte';
	import TextField from '#lib/ui/primitives/TextField.svelte';
	import { Draft } from '#lib/ui/save/draft.svelte.js';
	import { SaveStopped } from '#lib/ui/save/save-scope.js';
	import SaveScope from '#lib/ui/save/SaveScope.svelte';
	import Page from '#lib/ui/templates/Page.svelte';
	import { toast } from '#lib/ui/toast/toast.svelte.js';
	import StatementContentCard from './StatementContentCard.svelte';
	import { apiDetail, statementErrorKey, type StatementErrorContext } from './statement-errors';
	import {
		currentOf,
		draftOf,
		editorValue,
		isValidVersion,
		languageProblems,
		languageValue,
		localizationInput,
		sameLanguage,
		statementChange,
		statementName,
		statementStatus,
		todayVersion,
		versionLabel,
		type LanguageValue,
		type StatementEditorValue
	} from './statement-model';
	import StatementSettingsFields from './StatementSettingsFields.svelte';
	import StatementUsages from './StatementUsages.svelte';
	import StatementVersionsCard from './StatementVersionsCard.svelte';

	/**
	 * A consent statement's page. Its kind and details are saved with the save bar; the draft
	 * version's texts are edited in the content card and saved with it. Making a draft, publishing
	 * it (with the choice to ask people who agreed before again) and deleting a draft act at once
	 * and wait while there is unsaved work. A statement can be turned off, and deleted: one never
	 * used is deleted, any other is retired and its records kept.
	 */
	interface Props {
		client: ConsentStatementsClient;
		id: string;
		canWrite: boolean;
		listHref: string;
		/** The statement was deleted or retired: back to the list. */
		ondeleted: () => void;
	}

	let { client, id, canWrite, listHref, ondeleted }: Props = $props();

	const readonly = $derived(!canWrite);
	let phase = $state<'loading' | 'ready' | 'missing' | 'forbidden' | 'failed'>('loading');
	let statement = $state<ConsentStatement | null>(null);
	let versions = $state<ConsentVersion[]>([]);
	let texts = $state<Record<string, ConsentLocalization[]>>({});
	let usage = $state<ConsentStatementUsage | null>(null);
	let usageKnown = $state(false);
	let usageComplete = $state(true);
	let draft = $state(new Draft<StatementEditorValue>(placeholder()));
	let viewId = $state('');
	let attempted = $state(false);
	let dirty = $state(false);
	let saving = $state(false);
	let busy = $state(false);
	/** A save failed partway and what the server holds could not be read back: no publishing. */
	let stale = $state(false);

	let creating = $state(false);
	let newVersion = $state('');
	let newError = $state('');
	let publishing = $state<ConsentVersion | null>(null);
	let reconsent = $state(true);
	let publishError = $state('');
	let deletingVersion = $state<ConsentVersion | null>(null);
	let deleting = $state(false);
	let deactivating = $state(false);

	let gone = false;
	onDestroy(() => (gone = true));
	let loads = 0;

	function placeholder(): StatementEditorValue {
		return {
			category: 'other',
			legalBasis: 'consent',
			withdrawalAllowed: true,
			withdrawalImpact: '',
			retentionDays: null,
			reconsentDays: null,
			contentType: 'inline',
			languages: {}
		};
	}

	const draftVersion = $derived(draftOf(versions));
	const currentVersion = $derived(currentOf(versions));

	/** Fetches what the page shows; the shown version and unsaved edits are replaced by saved ones. */
	async function fetchAll(target: string) {
		const [detail, used] = await Promise.all([
			client.get(target),
			client.usages().then(
				(value) => value,
				() => null
			)
		]);
		const wanted = [draftOf(detail.versions), currentOf(detail.versions)].filter(
			(version): version is ConsentVersion => version !== null
		);
		const loaded = await Promise.all(
			wanted.map(
				async (version) => [version.id, await client.localizations(target, version.id)] as const
			)
		);
		return { detail, used, texts: Object.fromEntries(loaded) };
	}

	function apply(fetched: Awaited<ReturnType<typeof fetchAll>>, target: string) {
		stale = false;
		statement = fetched.detail.statement;
		versions = fetched.detail.versions;
		texts = fetched.texts;
		usage = fetched.used?.byStatement[target] ?? null;
		usageKnown = fetched.used !== null;
		usageComplete = fetched.used?.complete ?? true;
		const pending = draftOf(versions);
		const value = editorValue(statement, pending, pending ? (texts[pending.id] ?? []) : []);
		// The version being looked at stays when it still exists.
		if (!versions.some((version) => version.id === viewId)) {
			viewId = (pending ?? currentOf(versions) ?? versions[0])?.id ?? '';
		}
		return value;
	}

	async function load() {
		const turn = ++loads;
		const target = id;
		const current = () => !gone && turn === loads && id === target;
		phase = 'loading';
		attempted = false;
		viewId = '';
		try {
			const fetched = await fetchAll(target);
			if (!current()) return;
			draft = new Draft(apply(fetched, target));
			phase = 'ready';
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

	/** After a change: what the server holds now, shown as saved. */
	async function reload() {
		const target = id;
		const fetched = await fetchAll(target);
		if (gone || id !== target) return;
		draft.reset(apply(fetched, target));
	}

	$effect(() => {
		void id;
		untrack(() => void load());
	});

	async function view(versionId: string) {
		viewId = versionId;
		if (texts[versionId] || !statement) return;
		const target = statement.id;
		try {
			const loaded = await client.localizations(target, versionId);
			if (!gone && id === target) texts = { ...texts, [versionId]: loaded };
		} catch {
			toast.error(t('cs.error.load'));
		}
	}

	const viewed = $derived(versions.find((version) => version.id === viewId) ?? null);
	const editable = $derived(canWrite && !!viewed && viewed.id === draftVersion?.id);
	const status = $derived(statement ? statementStatus(statement, currentVersion) : 'draftOnly');
	const title = $derived.by(() => {
		if (!statement) return t('cs.editor.loading');
		const titles: Record<string, string> = {};
		const shown = currentVersion ?? draftVersion;
		for (const item of shown ? (texts[shown.id] ?? []) : []) titles[item.language] = item.title;
		return statementName(titles, i18n.locale, statement.slug);
	});

	function fail(error: unknown, context: StatementErrorContext) {
		toast.error(t(statementErrorKey(error, context)) + apiDetail(error));
	}

	async function save(from: StatementEditorValue) {
		if (!statement) throw new SaveStopped();
		const pending = draftVersion;
		if (pending) {
			for (const language of Object.values(from.languages)) {
				if (languageProblems(language, from.contentType).length > 0) {
					attempted = true;
					toast.error(t('cs.error.fix'));
					throw new SaveStopped();
				}
			}
		}
		const target = statement.id;
		// What the edits are compared with, as it was when the save started.
		const base = JSON.parse(JSON.stringify(draft.saved)) as StatementEditorValue;
		// The writes below are separate requests: once one went through, a later failure reloads
		// what the server holds, so the page (and what a publish checks) never shows a mix.
		let wrote = false;
		try {
			const change = statementChange(from, base, statement);
			if (Object.keys(change).length > 0) {
				wrote = true;
				const updated = await client.update(target, change);
				if (!gone && id === target) statement = updated;
			}
			if (pending) {
				const typeChanged = from.contentType !== base.contentType;
				if (typeChanged) {
					wrote = true;
					await client.updateVersion(target, pending.id, { content_type: from.contentType });
				}
				for (const [code, language] of Object.entries(from.languages)) {
					if (typeChanged || !sameLanguage(language, base.languages[code])) {
						wrote = true;
						await client.saveLocalization(
							target,
							pending.id,
							code,
							localizationInput(language, from.contentType)
						);
					}
				}
				for (const code of Object.keys(base.languages)) {
					if (!(code in from.languages)) {
						wrote = true;
						await client.removeLocalization(target, pending.id, code);
					}
				}
			}
			attempted = false;
			await reload();
			toast.success(t('cs.editor.saved'));
		} catch (error) {
			if (error instanceof SaveStopped) throw error;
			fail(error, 'save');
			if (wrote) {
				// What the server holds becomes the saved state; the edits stay on screen to retry.
				const edits = JSON.parse(JSON.stringify(from)) as StatementEditorValue;
				try {
					await reload();
					if (!gone && id === target) draft.value = edits;
				} catch {
					// The page keeps the edits; a later save or reload brings it back in line. Until
					// then what a publish would check may not be what the server holds.
					if (!gone && id === target) stale = true;
				}
			}
			throw new SaveStopped();
		}
	}

	async function act(work: () => Promise<void>, context: StatementErrorContext, quiet = false) {
		if (busy) return false;
		busy = true;
		try {
			await work();
			return true;
		} catch (error) {
			if (!quiet) fail(error, context);
			return false;
		} finally {
			busy = false;
		}
	}

	function openNewVersion() {
		newVersion = todayVersion();
		newError = '';
		creating = true;
	}

	async function createVersion() {
		if (!statement) return;
		if (!isValidVersion(newVersion)) {
			newError = t('cs.error.versionFormat');
			return;
		}
		const target = statement.id;
		const source = currentVersion;
		const done = await act(
			async () => {
				let created: ConsentVersion | null = null;
				try {
					created = await client.createVersion(target, {
						version: newVersion,
						content_type: source?.content_type ?? 'inline',
						effective_at: Date.now()
					});
					// A new version starts from what people agree to now.
					const made = created;
					for (const item of source ? (texts[source.id] ?? []) : []) {
						await client.saveLocalization(target, made.id, item.language, {
							title: item.title,
							description: item.description,
							processing_purpose: item.processing_purpose,
							withdrawal_impact: item.withdrawal_impact,
							document_url: item.document_url,
							inline_content: item.inline_content
						});
					}
					if (!gone && id === target) {
						viewId = made.id;
						await reload();
					}
				} catch (error) {
					if (created && !gone && id === target) {
						// The version was made but its texts were not all copied: show it so it can be
						// completed (making it again would fail, its number is taken).
						const made = created;
						creating = false;
						fail(error, 'version');
						try {
							viewId = made.id;
							await reload();
						} catch {
							// The list is reloaded on the next action.
						}
						return;
					}
					newError = t(statementErrorKey(error, 'version')) + apiDetail(error);
					throw error;
				}
			},
			'version',
			true
		);
		if (done && creating) {
			creating = false;
			toast.success(t('cs.versions.created'));
		} else if (!done) creating = !!newError;
	}

	function openPublish(version: ConsentVersion) {
		publishError = '';
		reconsent = true;
		publishing = version;
	}

	async function publish() {
		if (!statement || !publishing) return;
		// Fixed when the button is pressed: the version, the re-ask choice and the statement.
		const target = publishing;
		const ask = reconsent;
		const owner = statement.id;
		const stillAsked = () => !gone && id === owner && publishing === target;
		if (stale) {
			publishError = t('cs.error.stale');
			return;
		}
		publishError = '';
		let published = false;
		const done = await act(
			async () => {
				try {
					// What is checked is the version being published (there can be more than one draft).
					let items: Record<string, LanguageValue>;
					let contentType = target.content_type;
					if (target.id === draftVersion?.id) {
						items = draft.saved.languages;
						contentType = draft.saved.contentType;
					} else {
						const loaded = texts[target.id] ?? (await client.localizations(owner, target.id));
						items = Object.fromEntries(loaded.map((item) => [item.language, languageValue(item)]));
					}
					// Cancelled (or moved to another statement) while the texts loaded: nothing is published.
					if (!stillAsked()) return;
					if (Object.keys(items).length === 0) {
						publishError = t('cs.error.noText');
						return;
					}
					if (
						Object.values(items).some(
							(language) => languageProblems(language, contentType, true).length > 0
						)
					) {
						publishError = t('cs.error.publishIncomplete');
						return;
					}
					await client.activateVersion(owner, target.id, { reconsent: ask });
					published = true;
					if (!gone && id === owner) await reload();
				} catch (error) {
					publishError = t(statementErrorKey(error, 'publish')) + apiDetail(error);
					throw error;
				}
			},
			'publish',
			true
		);
		if (done && published) {
			if (publishing === target) publishing = null;
			if (!gone && id === owner) {
				viewId = target.id;
				toast.success(t('cs.versions.published'));
			}
		}
	}

	async function removeVersion() {
		if (!statement || !deletingVersion) return;
		const target = deletingVersion;
		const owner = statement.id;
		const done = await act(async () => {
			await client.removeVersion(owner, target.id);
			if (gone || id !== owner) return;
			if (viewId === target.id) viewId = '';
			await reload();
		}, 'version');
		deletingVersion = null;
		if (done) toast.success(t('cs.versions.deleted'));
	}

	async function setActive(active: boolean) {
		if (!statement) return;
		const target = statement.id;
		const done = await act(async () => {
			const updated = await client.update(target, { is_active: active });
			if (!gone && id === target) statement = updated;
		}, 'save');
		deactivating = false;
		if (done) toast.success(t(active ? 'cs.editor.turnedOn' : 'cs.editor.turnedOff'));
	}

	async function remove() {
		if (!statement) return;
		const target = statement;
		const done = await act(async () => {
			const disposition = await client.remove(target.id);
			toast.success(t(disposition === 'deleted' ? 'cs.editor.deleted' : 'cs.editor.retired'));
		}, 'delete');
		deleting = false;
		// Only when the page still shows the statement that was deleted.
		if (done && !gone && id === target.id) {
			draft.discard();
			ondeleted();
		}
	}

	const loadMessage = {
		missing: 'cs.editor.notFound',
		forbidden: 'cs.editor.noAccess',
		failed: 'cs.editor.loadFailed'
	} as const;
</script>

<SaveScope
	{draft}
	onsave={save}
	onstate={(state) => ((dirty = state.dirty), (saving = state.saving))}
>
	{#snippet children(controls)}
		<Page>
			<PageHeader {title}>
				{#snippet back()}<BackLink href={listHref}>{t('cs.editor.back')}</BackLink>{/snippet}
				{#snippet badges()}
					{#if phase === 'ready'}
						<Badge
							tone={status === 'active'
								? 'success'
								: status === 'draftOnly'
									? 'warning'
									: 'neutral'}
							dot
						>
							{t(`cs.status.${status}` as MessageKey)}
						</Badge>
					{/if}
				{/snippet}
				{#snippet actions()}
					{#if phase === 'ready' && statement && canWrite}
						{#if statement.retired_at === null && currentVersion}
							{#if statement.is_active}
								<Button disabled={controls.saving || busy} onclick={() => (deactivating = true)}>
									{t('cs.editor.turnOff')}
								</Button>
							{:else}
								<Button disabled={controls.saving || busy} onclick={() => void setActive(true)}>
									{t('cs.editor.turnOn')}
								</Button>
							{/if}
						{/if}
						<Button
							variant="danger"
							icon="trash"
							disabled={controls.saving || busy}
							onclick={() => (deleting = true)}>{t('cs.editor.delete')}</Button
						>
					{/if}
				{/snippet}
			</PageHeader>

			{#if phase === 'loading'}
				<LoadingState label={t('common.loading')} />
			{:else if phase !== 'ready' || !statement}
				<EmptyState
					icon={phase === 'forbidden' ? 'lock' : 'warningCircle'}
					title={t(loadMessage[phase === 'ready' ? 'failed' : phase])}
				>
					{#snippet action()}
						{#if phase === 'failed'}
							<Button size="sm" onclick={load}>{t('common.retry')}</Button>
						{:else if phase === 'missing'}
							<Button size="sm" href={listHref}>{t('cs.editor.back')}</Button>
						{/if}
					{/snippet}
				</EmptyState>
			{:else}
				{#if readonly}<Callout>{t('cs.editor.readOnly')}</Callout>{/if}
				{#if statement.retired_at !== null}
					<Callout tone="warning">{t('cs.editor.retiredNote')}</Callout>
				{/if}
				<fieldset class="editor__form" disabled={readonly}>
					<StatementSettingsFields {statement} bind:value={draft.value} disabled={readonly} />
				</fieldset>
				<StatementContentCard
					{versions}
					{viewId}
					onview={(versionId) => void view(versionId)}
					texts={viewed && (viewed.id !== draftVersion?.id || !editable)
						? (texts[viewed.id] ?? null)
						: null}
					bind:value={draft.value}
					{editable}
					{attempted}
				/>
				<StatementVersionsCard
					{versions}
					{canWrite}
					blocked={dirty || saving || busy}
					{viewId}
					onview={(versionId) => void view(versionId)}
					onnew={openNewVersion}
					onpublish={openPublish}
					ondelete={(version) => (deletingVersion = version)}
				/>
				<Card title={t('cs.usage.title')} description={t('cs.usage.intro')}>
					<StatementUsages {usage} known={usageKnown} complete={usageComplete} />
				</Card>
			{/if}
		</Page>
	{/snippet}
</SaveScope>

<FormDialog
	open={creating}
	title={t('cs.versions.newTitle')}
	description={currentVersion ? t('cs.versions.newCopy') : t('cs.versions.newBlank')}
	submitLabel={t('cs.versions.newSubmit')}
	{busy}
	error={newError}
	onsubmit={() => void createVersion()}
	oncancel={() => (creating = false)}
>
	<TextField
		label={t('cs.versions.number')}
		hint={t('cs.versions.numberHint')}
		maxlength={8}
		inputmode="numeric"
		bind:value={newVersion}
	/>
</FormDialog>

<FormDialog
	open={publishing !== null}
	title={t('cs.publish.title', { version: versionLabel(publishing?.version ?? '') })}
	description={t('cs.publish.intro')}
	submitLabel={t('cs.publish.submit')}
	{busy}
	error={publishError}
	onsubmit={() => void publish()}
	oncancel={() => (publishing = null)}
>
	<Checkbox
		bind:checked={reconsent}
		description={reconsent ? t('cs.publish.reconsentOn') : t('cs.publish.reconsentOff')}
	>
		{t('cs.publish.reconsent')}
	</Checkbox>
	{#if statement?.required_consent_version}
		<p class="editor__note">
			{t('cs.publish.boundary', { version: versionLabel(statement.required_consent_version) })}
		</p>
	{/if}
</FormDialog>

<ConfirmDialog
	open={deletingVersion !== null}
	title={t('cs.versions.deleteTitle', { version: versionLabel(deletingVersion?.version ?? '') })}
	body={t('cs.versions.deleteBody')}
	confirmLabel={t('cs.versions.delete')}
	tone="danger"
	{busy}
	onconfirm={() => void removeVersion()}
	oncancel={() => (deletingVersion = null)}
/>

<ConfirmDialog
	open={deactivating}
	title={t('cs.editor.turnOffTitle')}
	body={t('cs.editor.turnOffBody')}
	confirmLabel={t('cs.editor.turnOff')}
	{busy}
	onconfirm={() => void setActive(false)}
	oncancel={() => (deactivating = false)}
/>

<ConfirmDialog
	open={deleting}
	title={t('cs.editor.deleteTitle', { name: title })}
	body={t('cs.editor.deleteBody')}
	confirmLabel={t('cs.editor.delete')}
	tone="danger"
	{busy}
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

	.editor__note {
		margin: 0;
		color: var(--text-secondary);
		font-size: var(--fs-caption);
	}
</style>
