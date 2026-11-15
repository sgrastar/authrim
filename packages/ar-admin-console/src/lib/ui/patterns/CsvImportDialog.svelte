<script lang="ts">
	import { onDestroy } from 'svelte';
	import { t, type MessageKey } from '#lib/i18n/i18n.svelte.js';
	import { ApiError, ConflictError } from '#lib/api/api-error.js';
	import {
		CSV_HEADERS,
		CSV_MAX_BYTES,
		IDENTIFIER_NAME,
		importConflictOf,
		rowErrorsOf,
		type CsvImportKind,
		type CsvRowError
	} from '#lib/api/identifier-materials.js';
	import TextArea from '../primitives/TextArea.svelte';
	import TextField from '../primitives/TextField.svelte';
	import Callout from './Callout.svelte';
	import ConfirmDialog from './ConfirmDialog.svelte';
	import FileDrop from './FileDrop.svelte';
	import FormDialog from './FormDialog.svelte';
	import { useIdentifierMaterials } from './identifier-materials-context';
	import {
		isHeaderOnly,
		ROW_ERRORS_SHOWN,
		rowErrorKey,
		sortedRowErrors,
		type CsvImportResult
	} from './identifier-import-model';

	/**
	 * Imports a CSV into an identifier source, a store of identifiers or an exception list, by
	 * file or by pasting. All rows are written or none: rows the server refuses are listed (line,
	 * column, reason; never the value) and nothing is saved.
	 *
	 * A source or a store that already holds another value for some accounts asks before
	 * replacing them (the identifiers of those accounts change). A value another account holds is
	 * never replaced. An exception list is always replaced as a whole, so that is asked before
	 * anything is sent when the list exists; a file with only its header line empties it.
	 */
	interface Props {
		open: boolean;
		kind: CsvImportKind;
		/** The name to start with (the one the step has chosen). */
		name?: string;
		onimported: (result: CsvImportResult) => void;
		oncancel: () => void;
	}

	let { open, kind, name: initialName = '', onimported, oncancel }: Props = $props();

	const client = useIdentifierMaterials();
	let gone = false;
	onDestroy(() => (gone = true));

	let name = $state('');
	let csv = $state('');
	/** What was asked about, sent exactly as it was (the field cannot change it meanwhile). */
	let frozen = $state<{ name: string; csv: string } | null>(null);
	/** A chosen file is still being read: sending waits, and only the latest choice counts. */
	let reading = $state(false);
	let generation = 0;
	let files = $state<File[]>([]);
	let busy = $state(false);
	let error = $state('');
	let nameError = $state('');
	let csvError = $state('');
	let rowErrors = $state<CsvRowError[]>([]);
	/** Asked about before sending (an exception list) or before replacing (a source, a store). */
	let confirming = $state<
		{ type: 'list'; empty: boolean } | { type: 'values'; count: number } | null
	>(null);

	$effect(() => {
		if (!open) return;
		name = initialName;
		csv = '';
		files = [];
		error = nameError = csvError = '';
		rowErrors = [];
		confirming = null;
		frozen = null;
		generation++;
		reading = false;
	});

	// A chosen file's text goes into the field, where it can be looked at and changed.
	$effect(() => {
		const file = files[0];
		const mine = ++generation;
		if (!file) {
			reading = false;
			return;
		}
		reading = true;
		// The previous file's content is never kept under the new file's name.
		csv = '';
		csvError = '';
		file.text().then(
			(text) => {
				// A slower, earlier file never overwrites a later choice.
				if (gone || mine !== generation) return;
				csv = text;
				reading = false;
			},
			() => {
				if (gone || mine !== generation) return;
				csvError = t('pid.csv.error.readFailed');
				reading = false;
			}
		);
	});

	const header = $derived(CSV_HEADERS[kind]);
	const shownRows = $derived(sortedRowErrors(rowErrors));

	function reasonOf(code: string): string {
		const key = rowErrorKey(code);
		return key ? t(key) : t('pid.csv.rowUnknown', { code });
	}

	const rowText = (row: CsvRowError) =>
		row.column === 'row' || !row.column
			? t('pid.csv.rowItemWhole', { row: row.row, reason: reasonOf(row.code) })
			: t('pid.csv.rowItem', { row: row.row, column: row.column, reason: reasonOf(row.code) });

	function problem(cause: unknown, replaced: boolean): void {
		if (cause instanceof ConflictError) {
			const { conflicts, valuesOfOthers } = importConflictOf(
				kind === 'store' ? 'store' : 'source',
				cause.body
			);
			if (valuesOfOthers > 0) error = t('pid.csv.error.othersValues', { count: valuesOfOthers });
			else if (conflicts > 0 && kind !== 'exceptions' && !replaced)
				confirming = { type: 'values', count: conflicts };
			else error = t('pid.csv.error.changed');
			return;
		}
		if (cause instanceof ApiError) {
			if (cause.forbidden) {
				error = t('pid.error.forbidden');
				return;
			}
			if (cause.status === 400) {
				rowErrors = rowErrorsOf(cause.body);
				if (rowErrors.length === 0) error = t('pid.csv.error.invalid');
				return;
			}
		}
		error = t('pid.csv.error.generic');
	}

	async function send(replace: boolean) {
		if (!frozen) return;
		const { name: kept, csv: body } = frozen;
		busy = true;
		try {
			if (kind === 'exceptions') {
				const counts = await client.importExceptions(kept, body);
				if (gone) return;
				onimported({ kind, name: kept, counts });
			} else {
				const counts =
					kind === 'source'
						? await client.importSource(kept, body, replace)
						: await client.importStore(kept, body, replace);
				if (gone) return;
				onimported({ kind, name: kept, counts });
			}
			confirming = null;
		} catch (cause) {
			if (gone) return;
			confirming = null;
			problem(cause, replace);
		} finally {
			if (!gone) busy = false;
		}
	}

	async function submit() {
		if (busy || reading) return;
		error = nameError = csvError = '';
		rowErrors = [];
		const kept = name.trim();
		if (!kept) nameError = t('pid.error.name');
		else if (!IDENTIFIER_NAME.test(kept)) nameError = t('pid.nameHint');
		if (!csv.trim()) csvError = t('pid.csv.error.empty');
		if (nameError || csvError) return;
		frozen = { name: kept, csv };
		// An exception list is always replaced whole, and whether there is a list to lose is not
		// known here (the lists may still be loading, or not have loaded): always ask first.
		if (kind === 'exceptions') {
			confirming = { type: 'list', empty: isHeaderOnly(csv) };
			return;
		}
		await send(false);
	}
</script>

<FormDialog
	open={open && !confirming}
	title={t(`pid.csv.title.${kind}` as MessageKey)}
	submitLabel={t('pid.csv.submit')}
	busy={busy || reading}
	{error}
	onsubmit={submit}
	{oncancel}
>
	<TextField
		label={t('pid.csv.name')}
		bind:value={name}
		hint={t('pid.nameHint')}
		error={nameError}
		required
		spellcheck="false"
		autocomplete="off"
		dir="ltr"
	/>
	<p class="help">
		{t(`pid.csv.help.${kind}` as MessageKey, { header })}
		{t('pid.csv.limits')}
		{#if kind === 'exceptions'}{t('pid.csv.replacesList')}{/if}
	</p>
	<FileDrop label={t('pid.csv.file')} accept=".csv,text/csv" maxBytes={CSV_MAX_BYTES} bind:files />
	<TextArea
		label={t('pid.csv.paste')}
		bind:value={csv}
		error={csvError}
		mono
		rows={6}
		spellcheck="false"
		dir="ltr"
		placeholder={header}
	/>
	{#if shownRows.length > 0}
		<Callout tone="danger" title={t('pid.csv.rowsTitle', { count: shownRows.length })} live>
			<ul class="rows">
				{#each shownRows as row, index (index)}
					<li>{rowText(row)}</li>
				{/each}
			</ul>
			{#if shownRows.length >= ROW_ERRORS_SHOWN}
				<p class="more">{t('pid.csv.rowsMore', { count: ROW_ERRORS_SHOWN })}</p>
			{/if}
		</Callout>
	{/if}
</FormDialog>

{#if confirming?.type === 'list'}
	<ConfirmDialog
		open
		title={t('pid.csv.listReplaceTitle', { name: frozen?.name ?? '' })}
		body={confirming.empty ? t('pid.csv.listEmptyBody') : t('pid.csv.listReplaceBody')}
		confirmLabel={confirming.empty ? t('pid.csv.listEmptyConfirm') : t('pid.csv.replaceConfirm')}
		tone="danger"
		{busy}
		onconfirm={() => send(false)}
		oncancel={() => (confirming = null)}
	/>
{:else if confirming?.type === 'values' && kind !== 'exceptions'}
	<ConfirmDialog
		open
		title={t(`pid.csv.replaceTitle.${kind}` as MessageKey, { count: confirming.count })}
		body={t(`pid.csv.replaceBody.${kind}` as MessageKey, { count: confirming.count })}
		confirmLabel={t('pid.csv.replaceConfirm')}
		tone="danger"
		{busy}
		onconfirm={() => send(true)}
		oncancel={() => (confirming = null)}
	/>
{/if}

<style>
	.help {
		margin: 0;
		font-size: var(--fs-caption);
		line-height: var(--lh-snug);
		color: var(--text-muted);
	}

	.rows {
		margin: 0;
		padding-inline-start: 1.2em;
		max-height: 12rem;
		overflow-y: auto;
	}

	.more {
		margin: 4px 0 0;
		font-size: var(--fs-caption);
	}
</style>
