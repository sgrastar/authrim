<script lang="ts" module>
	export interface EditColumn {
		key: string;
		label: string;
		kind: 'text' | 'select' | 'checkbox';
		/** select: the choices. */
		options?: readonly { value: string; label: string }[];
		/** CSS width ("30%", "8rem"). */
		width?: string;
		/** Monospace text (paths, keys). */
		mono?: boolean;
		/** The shape of a value ("urn:…", "name.givenName"). */
		placeholder?: string;
		required?: boolean;
		/** No two rows may share a value in this column. */
		unique?: boolean;
		validate?: (value: string, row: Record<string, unknown>) => string | undefined;
	}
</script>

<script lang="ts" generics="T extends Record<string, unknown>">
	import { tick } from 'svelte';
	import { t } from '$lib/i18n/i18n.svelte';
	import { useBusy } from '../busy/busy';
	import Button from '../primitives/Button.svelte';
	import Checkbox from '../primitives/Checkbox.svelte';
	import IconButton from '../primitives/IconButton.svelte';
	import { sameValue } from '../save/draft.svelte';
	import { useChangeMark, useInvalidReport } from '../save/save-scope';
	import { isBlock, parseGrid, pasteIntoRows } from './grid-paste';
	import { duplicateIndexes } from './list-input';

	/**
	 * A table whose cells are edited in place: attribute definitions of an inbound or outbound
	 * source (path, label, type, flags), claim lists, anything that is naturally rows × columns.
	 *
	 * - Text, choice and checkbox cells; each has a full name for screen readers
	 *   ("Type, row email").
	 * - ↑ / ↓ in a text cell move to the same column in the row above or below; Enter moves
	 *   down, adding a row at the end.
	 * - Pasting a range copied from a spreadsheet fills the cells from the focused one and adds
	 *   rows as needed; choices accept their value or label, checkboxes "yes / 1 / true / ✓".
	 * - Required, unique and custom checks show in the cell; `invalid` is reported to the
	 *   SaveScope. Inside a SaveScope (`field`), changed cells and new rows take the change
	 *   colour.
	 * - Wider than the screen, it scrolls sideways inside its frame.
	 */
	interface Props {
		label: string;
		columns: readonly EditColumn[];
		rows?: T[];
		/** A new, empty row. */
		makeRow: () => T;
		/** How a row is named in labels; defaults to its first text cell. */
		rowName?: (row: T, index: number) => string;
		addLabel?: string;
		hint?: string;
		invalid?: boolean;
		field?: string;
	}

	let {
		label,
		columns,
		rows = $bindable([]),
		makeRow,
		rowName,
		addLabel = t('grid.add'),
		hint,
		invalid = $bindable(false),
		field
	}: Props = $props();

	const uid = $props.id();
	const busy = useBusy();
	const changes = useChangeMark();
	const report = useInvalidReport();
	let table = $state<HTMLTableElement>();
	let announcement = $state('');

	const firstText = $derived(columns.find((c) => c.kind === 'text'));
	const nameOf = (row: T, index: number) =>
		rowName?.(row, index) ??
		(firstText && String(row[firstText.key] ?? '').trim()) ??
		t('builder.row', { n: index + 1 });
	const named = (row: T, index: number) => nameOf(row, index) || t('builder.row', { n: index + 1 });

	/** Problems by row, then column key. */
	const problems = $derived.by(() => {
		const found: Record<string, string>[] = rows.map(() => ({}));
		for (const column of columns) {
			if (column.kind !== 'text') continue;
			const values = rows.map((row) => String(row[column.key] ?? ''));
			const repeated = column.unique ? duplicateIndexes(values) : new Set<number>();
			values.forEach((value, r) => {
				const problem =
					column.required && !value.trim()
						? t('grid.required')
						: repeated.has(r)
							? t('list.duplicate')
							: value.trim()
								? column.validate?.(value.trim(), rows[r])
								: undefined;
				if (problem) found[r][column.key] = problem;
			});
		}
		return found;
	});
	$effect(() => {
		invalid = problems.some((row) => Object.keys(row).length > 0);
	});
	$effect(() => report(invalid));

	const saved = $derived(field ? (changes.original(field) as T[] | undefined) : undefined);
	const cellChanged = (r: number, key: string) =>
		!!field && (!saved || r >= saved.length || !sameValue(saved[r]?.[key], rows[r][key]));
	const rowIsNew = (r: number) => !!field && (!saved || r >= saved.length);

	function set(r: number, key: string, value: unknown) {
		rows = rows.map((row, i) => (i === r ? { ...row, [key]: value } : row));
	}

	async function focusCell(r: number, c: number) {
		await tick();
		table?.querySelector<HTMLElement>(`[data-cell="${r}:${c}"]`)?.focus();
	}

	async function addRow(focusColumn = 0) {
		rows = [...rows, makeRow()];
		await focusCell(rows.length - 1, focusColumn);
	}

	function removeRow(r: number) {
		rows = rows.filter((_, i) => i !== r);
		focusCell(Math.min(r, rows.length - 1), 0);
	}

	function keydown(event: KeyboardEvent, r: number, c: number) {
		if (event.key === 'ArrowUp' && r > 0) {
			event.preventDefault();
			focusCell(r - 1, c);
		} else if (event.key === 'ArrowDown' && r < rows.length - 1) {
			event.preventDefault();
			focusCell(r + 1, c);
		} else if (event.key === 'Enter') {
			event.preventDefault();
			if (r < rows.length - 1) focusCell(r + 1, c);
			else addRow(c);
		}
	}

	function paste(event: ClipboardEvent, r: number, c: number) {
		const text = event.clipboardData?.getData('text') ?? '';
		if (!isBlock(text)) return;
		event.preventDefault();
		const grid = parseGrid(text);
		rows = pasteIntoRows(rows, { row: r, column: c }, columns, grid, makeRow);
		announcement = t('grid.pasted', { n: grid.length });
	}
</script>

<div class="etable">
	<div class="etable__scroll" role="region" aria-label={label} aria-describedby="{uid}-hint">
		<table bind:this={table}>
			<caption class="sr-only">{label}</caption>
			<thead>
				<tr>
					{#each columns as column (column.key)}
						<th scope="col" style:width={column.width} class:is-center={column.kind === 'checkbox'}>
							{column.label}{#if column.required}<span class="etable__req" aria-hidden="true"
									>*</span
								>{/if}
						</th>
					{/each}
					<th scope="col" class="etable__actions"
						><span class="sr-only">{t('grid.actions')}</span></th
					>
				</tr>
			</thead>
			<tbody>
				{#each rows as row, r (r)}
					{@const name = named(row, r)}
					<tr class:is-new={rowIsNew(r)}>
						{#each columns as column, c (column.key)}
							{@const problem = problems[r]?.[column.key]}
							{@const cellName = t('grid.cell', { column: column.label, row: name })}
							<td
								class:is-center={column.kind === 'checkbox'}
								class:is-changed={cellChanged(r, column.key)}
							>
								{#if column.kind === 'text'}
									<input
										data-cell="{r}:{c}"
										class:is-mono={column.mono}
										dir={column.mono ? 'ltr' : undefined}
										class:has-error={!!problem}
										value={String(row[column.key] ?? '')}
										placeholder={column.placeholder}
										aria-label={cellName}
										aria-invalid={problem ? 'true' : undefined}
										aria-describedby={problem ? `${uid}-p-${r}-${c}` : undefined}
										spellcheck="false"
										autocomplete="off"
										readonly={busy()}
										oninput={(event) => set(r, column.key, event.currentTarget.value)}
										onkeydown={(event) => keydown(event, r, c)}
										onpaste={(event) => paste(event, r, c)}
									/>
									{#if problem}<p class="etable__problem" id="{uid}-p-{r}-{c}">{problem}</p>{/if}
								{:else if column.kind === 'select'}
									<select
										data-cell="{r}:{c}"
										value={String(row[column.key] ?? '')}
										aria-label={cellName}
										disabled={busy()}
										onchange={(event) => set(r, column.key, event.currentTarget.value)}
									>
										{#each column.options ?? [] as option (option.value)}
											<option value={option.value}>{option.label}</option>
										{/each}
									</select>
								{:else}
									<span class="etable__check" data-cell="{r}:{c}">
										<Checkbox
											hideLabel
											changeMark="box"
											checked={row[column.key] === true}
											changed={cellChanged(r, column.key)}
											onchange={(event) => set(r, column.key, event.currentTarget.checked)}
											>{cellName}</Checkbox
										>
									</span>
								{/if}
							</td>
						{/each}
						<td class="etable__actions">
							<IconButton
								icon="trash"
								label={t('grid.remove', { name })}
								disabled={busy()}
								onclick={() => removeRow(r)}
							/>
						</td>
					</tr>
				{/each}
			</tbody>
		</table>
	</div>
	<p class="etable__hint" id="{uid}-hint">{hint ? `${hint} ` : ''}{t('grid.pasteHint')}</p>
	<div>
		<Button size="sm" variant="secondary" icon="plus" disabled={busy()} onclick={() => addRow()}
			>{addLabel}</Button
		>
	</div>
	<p class="sr-only" aria-live="polite">{announcement}</p>
</div>

<style>
	.etable {
		display: grid;
		gap: 8px;
		min-width: 0;
	}

	.etable__scroll {
		overflow-x: auto;
		border: 1px solid var(--border);
		border-radius: var(--radius-control);
		background: var(--bg-card);
	}

	table {
		width: max-content;
		min-width: 100%;
		border-collapse: collapse;
		font-size: var(--fs-body);
	}

	th {
		padding: 6px 8px;
		border-bottom: 1px solid var(--border);
		background: var(--bg-subtle);
		color: var(--text-secondary);
		font-size: var(--fs-small);
		font-weight: var(--fw-semibold);
		text-align: start;
		white-space: nowrap;
	}

	.etable__req {
		margin-inline-start: 2px;
		color: var(--danger);
	}

	td {
		padding: 4px;
		border-bottom: 1px solid var(--border-subtle);
		vertical-align: top;
	}

	tbody tr:last-child td {
		border-bottom: 0;
	}

	.is-center {
		text-align: center;
	}

	/* New rows and changed cells take the change colour. */
	tr.is-new td,
	td.is-changed {
		background: var(--changed-bg);
	}

	input,
	select {
		width: 100%;
		min-width: 7rem;
		height: var(--control-h-sm);
		padding: 0 6px;
		border: 1px solid transparent;
		border-radius: var(--radius-xs);
		background: transparent;
		color: var(--text-primary);
		font: inherit;
		font-size: var(--fs-body);
	}

	/* A cell looks like a cell until it is used: the box appears on hover and focus. */
	input:hover,
	select:hover {
		border-color: var(--border);
		background: var(--bg-input);
	}

	input:focus-visible,
	select:focus-visible {
		border-color: var(--focus-ring);
		background: var(--bg-input);
		outline: 2px solid color-mix(in srgb, var(--focus-ring) 35%, transparent);
		outline-offset: 0;
	}

	input.is-mono {
		font-family: var(--font-mono);
	}

	input::placeholder {
		color: var(--text-muted);
		opacity: 1;
	}

	input.has-error {
		border-color: var(--danger);
		background: var(--bg-input);
	}

	select {
		cursor: pointer;
	}

	.etable__check {
		display: inline-flex;
		align-items: center;
		justify-content: center;
		min-height: var(--control-h-sm);
	}

	.etable__actions {
		width: var(--control-h-dense);
	}

	.etable__problem {
		margin: 2px 6px 0;
		color: var(--danger);
		font-size: var(--fs-small);
		white-space: normal;
	}

	.etable__hint {
		margin: 0;
		color: var(--text-muted);
		font-size: var(--fs-caption);
	}
</style>
