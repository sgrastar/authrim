<script lang="ts" module>
	export interface TranslationRow {
		id: string;
		/** What the text is ("Passkey", "Input field · Placeholder"); the source text goes below. */
		label: string;
		/** The text in the default language. */
		source: string;
	}

	export interface TranslationLocale {
		code: string;
		/** Name of the language, in its own language. */
		name: string;
	}

	/** Translations by text id, then locale code. */
	export type Translations = Record<string, Record<string, string>>;
</script>

<script lang="ts">
	import { t } from '$lib/i18n/i18n.svelte';
	import { useBusy } from '../busy/busy';
	import { useChangeMark } from '../save/save-scope';

	/**
	 * Translate a page's texts into several languages at once. The first column (what the text
	 * is, and its default-language wording) stays put while the language columns scroll
	 * sideways, so the source is always next to the translation being written.
	 *
	 * - An empty entry shows the default wording faintly: that is what users will see.
	 * - Each language's heading counts what is not translated yet.
	 * - Inside a SaveScope (`field` = path of the translations), changed entries are marked.
	 */
	interface Props {
		label: string;
		rows: readonly TranslationRow[];
		/** The languages to translate into (not the default one). */
		locales: readonly TranslationLocale[];
		/** The default language the source texts are in. */
		source: TranslationLocale;
		values?: Translations;
		field?: string;
	}

	let { label, rows, locales, source, values = $bindable({}), field }: Props = $props();

	const busy = useBusy();
	const changes = useChangeMark();

	const valueOf = (rowId: string, code: string) => values[rowId]?.[code] ?? '';

	function isChanged(rowId: string, code: string): boolean {
		if (field === undefined) return false;
		const saved = (changes.original(`${field}.${rowId}.${code}`) as string | undefined) ?? '';
		return saved !== valueOf(rowId, code);
	}

	const missing = $derived(
		Object.fromEntries(
			locales.map((locale) => [
				locale.code,
				rows.filter((row) => valueOf(row.id, locale.code).trim() === '').length
			])
		)
	);

	function set(rowId: string, code: string, text: string) {
		values = { ...values, [rowId]: { ...(values[rowId] ?? {}), [code]: text } };
	}
</script>

<div class="translations">
	<p class="translations__note">{t('translate.fallback', { locale: source.name })}</p>
	<!-- Scrolls sideways; tabbing through the entries scrolls each one into view. -->
	<div class="translations__scroll" role="region" aria-label={label}>
		<table>
			<thead>
				<tr>
					<th scope="col" class="sticky">{t('translate.text')}</th>
					{#each locales as locale (locale.code)}
						<th scope="col">
							<span lang={locale.code}>{locale.name}</span>
							<small class:is-done={missing[locale.code] === 0}>
								{missing[locale.code] === 0
									? t('translate.complete')
									: t('translate.missing', { n: missing[locale.code] })}
							</small>
						</th>
					{/each}
				</tr>
			</thead>
			<tbody>
				{#each rows as row (row.id)}
					<tr>
						<th scope="row" class="sticky">
							<span class="row-role">{row.label}</span>
							<span class="row-source" lang={source.code}>{row.source}</span>
						</th>
						{#each locales as locale (locale.code)}
							{@const changed = isChanged(row.id, locale.code)}
							<td>
								<input
									class:is-changed={changed}
									value={valueOf(row.id, locale.code)}
									placeholder={row.source}
									lang={locale.code}
									dir="auto"
									readonly={busy()}
									aria-label="{row.label} — {locale.name}{changed
										? ` (${t('common.changed')})`
										: ''}"
									oninput={(event) => set(row.id, locale.code, event.currentTarget.value)}
								/>
							</td>
						{/each}
					</tr>
				{/each}
			</tbody>
		</table>
	</div>
</div>

<style>
	.translations {
		display: grid;
		gap: 10px;
		min-width: 0;
	}

	.translations__note {
		margin: 0;
		color: var(--text-secondary);
		font-size: var(--fs-label);
	}

	.translations__scroll {
		/* The sticky column's z-index stays local. */
		isolation: isolate;
		overflow-x: auto;
		border: 1px solid var(--border);
		border-radius: var(--radius-panel);
		background: var(--bg-card);
	}

	table {
		width: max-content;
		min-width: 100%;
		border-collapse: separate;
		border-spacing: 0;
		font-size: var(--fs-body);
	}

	th,
	td {
		padding: 10px 12px;
	}

	tbody th,
	tbody td {
		padding-block: 6px;
	}

	th,
	td {
		border-bottom: 1px solid var(--border-subtle);
		vertical-align: top;
		text-align: start;
	}

	tbody tr:last-child > * {
		border-bottom: 0;
	}

	thead th {
		background: var(--bg-subtle);
		color: var(--text-secondary);
		font-size: var(--fs-caption);
		font-weight: var(--fw-semibold);
		white-space: nowrap;
	}

	thead th small {
		display: block;
		margin-top: 2px;
		color: var(--warning-text);
		font-size: var(--fs-small);
		font-weight: var(--fw-medium);
	}

	thead th small.is-done {
		color: var(--text-muted);
	}

	/* The source column stays while the languages scroll under it. */
	.sticky {
		position: sticky;
		inset-inline-start: 0;
		z-index: 1;
		width: 240px;
		min-width: 240px;
		max-width: 240px;
		border-inline-end: 1px solid var(--border);
		background: var(--bg-card);
	}

	thead .sticky {
		background: var(--bg-subtle);
	}

	tbody th {
		font-weight: var(--fw-regular);
	}

	/* Two lines, as on the canvas: what the text is, then its wording in the default language. */
	.row-role {
		display: block;
		color: var(--text-primary);
		font-weight: var(--fw-medium);
		overflow-wrap: anywhere;
	}

	.row-source {
		display: block;
		margin-top: 1px;
		color: var(--text-muted);
		font-size: var(--fs-small);
		overflow-wrap: anywhere;
	}

	td {
		min-width: 220px;
	}

	input {
		width: 100%;
		min-width: 200px;
		height: var(--control-h-dense);
		padding: 0 9px;
		border: 1px solid var(--border-strong);
		border-radius: var(--radius-control);
		background: var(--bg-input);
		color: var(--text-primary);
		font: inherit;
		font-size: var(--fs-body);
	}

	input::placeholder {
		color: var(--text-muted);
		opacity: 1;
	}

	input:focus-visible {
		border-color: var(--focus-ring);
		outline: 2px solid color-mix(in srgb, var(--focus-ring) 35%, transparent);
		outline-offset: 0;
	}

	input.is-changed {
		border-color: var(--changed-edge);
		background: linear-gradient(var(--changed-bg), var(--changed-bg)), var(--bg-input);
	}

	input[readonly] {
		background: var(--bg-subtle);
		color: var(--text-secondary);
		cursor: progress;
	}
</style>
