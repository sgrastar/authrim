<script lang="ts">
	import { tick } from 'svelte';
	import { t } from '$lib/i18n/i18n.svelte';
	import { useBusy } from '../busy/busy';
	import Icon from '../icons/Icon.svelte';
	import IconButton from '../primitives/IconButton.svelte';
	import {
		MAX_COLUMNS,
		findPart,
		insertPart,
		movePart,
		moveRow,
		removePart,
		removeRow,
		setColumns,
		stepPart,
		type DropTarget,
		type LayoutPart,
		type LayoutRow
	} from './layout-model';
	import { NEW_PART_TYPE } from './PartPalette.svelte';

	/**
	 * Arrange the parts of a page in rows of one to three columns.
	 * - Each row shows its column count as buttons drawn like the layout (1 | 2 | 3); fewer
	 *   columns move the parts of the removed columns into the last one kept, nothing is lost.
	 * - Drag a part (or a new one from PartPalette) into any column; a line shows where it
	 *   lands. Dropping between rows makes a new one-column row.
	 * - Keyboard: on a part, Alt + arrow keys move it (mirrored in RTL); every move is read out.
	 * - Drag a row by its grip to reorder rows; press its name to select the row (its own
	 *   settings, such as a display condition, are edited next to the canvas).
	 * - A part reads as two lines: what it is (`role`, e.g. "Passkey"), then the name users see.
	 */
	interface Props {
		label: string;
		rows?: LayoutRow[];
		/** Id of the selected part (its settings are edited next to the canvas). */
		selected?: string | null;
		/** Id of the selected row. Selecting a part clears it and the other way round. */
		selectedRow?: string | null;
		/** Makes a new part for a palette entry dropped on the canvas. */
		create: (kind: string) => LayoutPart;
		/** Parts that are new or changed since saving (with SaveScope) take the change colour. */
		changed?: (part: LayoutPart) => boolean;
		/** What a part is ("Passkey", "Divider"): its first line, above the name users see. */
		role?: (part: LayoutPart) => string;
	}

	let {
		label,
		rows = $bindable([]),
		selected = $bindable(null),
		selectedRow = $bindable(null),
		create,
		changed,
		role
	}: Props = $props();

	/** The part's name for buttons and announcements: its label, or what it is. */
	const nameOf = (part: LayoutPart) => part.label || role?.(part) || part.kind;

	function selectPart(id: string) {
		selected = id;
		selectedRow = null;
	}

	const MOVE_TYPE = 'application/x-authrim-move-part';
	const ROW_TYPE = 'application/x-authrim-move-row';
	const COLUMN_CHOICES = Array.from({ length: MAX_COLUMNS }, (_, index) => index + 1);

	const busy = useBusy();
	let root = $state<HTMLDivElement>();
	let counter = 0;
	const newRowId = () => `row-${Date.now().toString(36)}-${++counter}`;

	/** What is being dragged over the canvas right now. */
	let dragging = $state<'part' | 'new' | 'row' | null>(null);
	/** Where a part would land. */
	let hover = $state<DropTarget | null>(null);
	/** Where a dragged row would land (index between rows). */
	let rowHover = $state<number | null>(null);
	let announcement = $state('');

	const isEmpty = (row: LayoutRow) => row.columns.every((column) => column.length === 0);

	function dragKind(event: DragEvent): 'part' | 'new' | 'row' | null {
		const types = event.dataTransfer?.types ?? [];
		if (types.includes(MOVE_TYPE)) return 'part';
		if (types.includes(NEW_PART_TYPE)) return 'new';
		if (types.includes(ROW_TYPE)) return 'row';
		return null;
	}

	function clearDrag() {
		dragging = null;
		hover = null;
		rowHover = null;
	}

	function partName(id: string): string {
		const place = findPart(rows, id);
		return place ? nameOf(rows[place.row].columns[place.column][place.index]) : '';
	}

	function announceMove(id: string) {
		const place = findPart(rows, id);
		if (!place) return;
		announcement = t('builder.moved', {
			name: partName(id),
			row: place.row + 1,
			column: place.column + 1
		});
	}

	/** Over a column: the slot is before the first part whose middle is below the pointer. */
	function overColumn(event: DragEvent, row: LayoutRow, column: number) {
		const kind = dragKind(event);
		if (kind !== 'part' && kind !== 'new') return;
		event.preventDefault();
		event.stopPropagation();
		dragging = kind;
		if (event.dataTransfer) event.dataTransfer.dropEffect = kind === 'new' ? 'copy' : 'move';
		const list = event.currentTarget as HTMLElement;
		const parts = [...list.querySelectorAll<HTMLElement>(':scope > [data-part]')];
		let index = parts.length;
		for (let i = 0; i < parts.length; i++) {
			const rect = parts[i].getBoundingClientRect();
			if (event.clientY < rect.top + rect.height / 2) {
				index = i;
				break;
			}
		}
		hover = { kind: 'column', rowId: row.id, column, index };
		rowHover = null;
	}

	/** Over the gap between rows: a part becomes a new row there; a row moves there. */
	function overGap(event: DragEvent, index: number) {
		const kind = dragKind(event);
		if (!kind) return;
		event.preventDefault();
		dragging = kind;
		if (event.dataTransfer) event.dataTransfer.dropEffect = kind === 'new' ? 'copy' : 'move';
		if (kind === 'row') {
			rowHover = index;
			hover = null;
		} else {
			hover = { kind: 'row', index };
			rowHover = null;
		}
	}

	function drop(event: DragEvent) {
		event.preventDefault();
		event.stopPropagation();
		const target = hover;
		const rowIndex = rowHover;
		const movedId = event.dataTransfer?.getData(MOVE_TYPE);
		const newKind = event.dataTransfer?.getData(NEW_PART_TYPE);
		const rowId = event.dataTransfer?.getData(ROW_TYPE);
		clearDrag();
		if (rowId && rowIndex !== null) {
			const from = rows.findIndex((row) => row.id === rowId);
			rows = moveRow(rows, rowId, from < rowIndex ? rowIndex - 1 : rowIndex);
			return;
		}
		if (!target) return;
		if (movedId) {
			rows = movePart(rows, movedId, target, newRowId);
			announceMove(movedId);
		} else if (newKind) {
			const part = create(newKind);
			rows = insertPart(rows, part, target, newRowId);
			selectPart(part.id);
			announcement = t('builder.added', { name: nameOf(part) });
		}
	}

	function remove(part: LayoutPart) {
		rows = removePart(rows, part.id);
		if (selected === part.id) selected = null;
		announcement = t('builder.removed', { name: nameOf(part) });
	}

	async function keyMove(event: KeyboardEvent, part: LayoutPart) {
		if (!event.altKey || !root) return;
		const rtl = getComputedStyle(root).direction === 'rtl';
		const direction = (
			{
				ArrowUp: 'up',
				ArrowDown: 'down',
				ArrowLeft: rtl ? 'right' : 'left',
				ArrowRight: rtl ? 'left' : 'right'
			} as const
		)[event.key as 'ArrowUp' | 'ArrowDown' | 'ArrowLeft' | 'ArrowRight'];
		if (!direction) return;
		event.preventDefault();
		rows = stepPart(rows, part.id, direction, newRowId);
		announceMove(part.id);
		await tick();
		root.querySelector<HTMLElement>(`[data-part="${CSS.escape(part.id)}"] .part__main`)?.focus();
	}
</script>

{#snippet gap(index: number, last: boolean)}
	<div
		class="gap"
		class:is-open={dragging !== null}
		class:is-target={(hover?.kind === 'row' && hover.index === index) || rowHover === index}
		class:gap--last={last}
		role="presentation"
		ondragover={(event) => overGap(event, index)}
		ondrop={drop}
	>
		<span class="gap__line"></span>
		{#if dragging === 'part' || dragging === 'new'}<span class="gap__label"
				>{t('builder.newRow')}</span
			>{/if}
	</div>
{/snippet}

<div
	class="canvas"
	class:is-dragging={dragging !== null}
	role="region"
	aria-label={label}
	bind:this={root}
	ondragleave={(event) => {
		if (!root?.contains(event.relatedTarget as Node | null)) {
			hover = null;
			rowHover = null;
		}
	}}
>
	{#if rows.length === 0}
		<div
			class="canvas__empty"
			class:is-target={hover?.kind === 'row'}
			role="presentation"
			ondragover={(event) => overGap(event, 0)}
			ondrop={drop}
		>
			<Icon name="plus" />
			<p>{t('builder.empty')}</p>
		</div>
	{/if}

	{#each rows as row, r (row.id)}
		{@render gap(r, false)}
		<section
			class="row"
			class:is-selected={selectedRow === row.id}
			aria-label={t('builder.row', { n: r + 1 })}
		>
			<div class="row__bar">
				<span
					class="row__grip"
					draggable={!busy()}
					role="presentation"
					title={t('builder.moveRow', { row: t('builder.row', { n: r + 1 }) })}
					ondragstart={(event) => {
						event.dataTransfer?.setData(ROW_TYPE, row.id);
						event.dataTransfer?.setData('text/plain', t('builder.row', { n: r + 1 }));
						if (event.dataTransfer) event.dataTransfer.effectAllowed = 'move';
						dragging = 'row';
					}}
					ondragend={clearDrag}><Icon name="grip" /></span
				>
				<span class="row__name">
					<button
						type="button"
						aria-pressed={selectedRow === row.id}
						disabled={busy()}
						onclick={() => {
							selectedRow = row.id;
							selected = null;
						}}>{t('builder.row', { n: r + 1 })}</button
					>
				</span>
				<div class="row__switch" role="group" aria-label={t('builder.columns')}>
					{#each COLUMN_CHOICES as count (count)}
						<button
							type="button"
							aria-pressed={row.columns.length === count}
							aria-label={t('builder.columnsN', { n: count })}
							title={t('builder.columnsN', { n: count })}
							disabled={busy()}
							onclick={() => (rows = setColumns(rows, row.id, count))}
						>
							<span class="glyph" aria-hidden="true">
								{#each Array.from({ length: count }, (_, i) => i) as cell (cell)}<i></i>{/each}
							</span>
						</button>
					{/each}
				</div>
				{#if isEmpty(row)}
					<span class="row__remove">
						<IconButton
							icon="trash"
							label={t('builder.removeRow')}
							onclick={() => (rows = removeRow(rows, row.id))}
						/>
					</span>
				{/if}
			</div>
			<div
				class="row__cols"
				class:row__cols--multi={row.columns.length > 1}
				style:--cols={row.columns.length}
			>
				{#each row.columns as column, c (c)}
					<div
						class="col"
						class:is-target={hover?.kind === 'column' &&
							hover.rowId === row.id &&
							hover.column === c}
						class:is-empty={column.length === 0}
						role="group"
						aria-label={row.columns.length > 1 ? t('builder.column', { n: c + 1 }) : undefined}
						ondragover={(event) => overColumn(event, row, c)}
						ondrop={drop}
					>
						{#each column as part, i (part.id)}
							{#if hover?.kind === 'column' && hover.rowId === row.id && hover.column === c && hover.index === i}
								<span class="drop-line" aria-hidden="true"></span>
							{/if}
							<div
								class="part"
								class:is-selected={selected === part.id}
								class:is-changed={changed?.(part) ?? false}
								data-part={part.id}
								draggable={!busy()}
								role="presentation"
								ondragstart={(event) => {
									event.dataTransfer?.setData(MOVE_TYPE, part.id);
									event.dataTransfer?.setData('text/plain', nameOf(part));
									if (event.dataTransfer) event.dataTransfer.effectAllowed = 'move';
									dragging = 'part';
								}}
								ondragend={clearDrag}
							>
								<span class="part__grip" aria-hidden="true"><Icon name="grip" /></span>
								<button
									type="button"
									class="part__main"
									aria-pressed={selected === part.id}
									aria-label="{t('builder.select', { name: nameOf(part) })}{changed?.(part)
										? ` (${t('common.changed')})`
										: ''}"
									disabled={busy()}
									onclick={() => selectPart(part.id)}
									onkeydown={(event) => keyMove(event, part)}
								>
									{#if role}
										<span class="part__role">{role(part)}</span>
										{#if part.label}<small>{part.label}</small>{/if}
									{:else}
										<span class="part__role">{part.label}</span>
									{/if}
								</button>
								<IconButton
									icon="trash"
									label={t('builder.remove', { name: nameOf(part) })}
									onclick={() => remove(part)}
								/>
							</div>
						{/each}
						{#if hover?.kind === 'column' && hover.rowId === row.id && hover.column === c && hover.index === column.length && column.length > 0}
							<span class="drop-line" aria-hidden="true"></span>
						{/if}
						{#if column.length === 0}
							<p class="col__empty">{t('builder.dropHere')}</p>
						{/if}
					</div>
				{/each}
			</div>
		</section>
	{/each}
	{#if rows.length > 0}{@render gap(rows.length, true)}{/if}

	<p class="sr-only" aria-live="polite">{announcement}</p>
</div>

<style>
	.canvas {
		display: flex;
		flex-direction: column;
		min-width: 0;
	}

	.canvas__empty {
		display: grid;
		place-items: center;
		gap: 8px;
		min-height: 180px;
		padding: 24px;
		border: 1.5px dashed var(--border-strong);
		border-radius: var(--radius-panel);
		color: var(--text-secondary);
		text-align: center;
		--icon-size: var(--icon-xl);
	}

	.canvas__empty p {
		margin: 0;
		font-size: var(--fs-body);
	}

	.canvas__empty.is-target {
		border-color: var(--primary);
		background: var(--bg-hover);
	}

	/* Between rows: a hairline of space that opens while dragging, so a new row can be made. */
	.gap {
		position: relative;
		display: grid;
		place-items: center;
		height: 10px;
		transition: height 160ms ease;
	}

	.gap--last {
		height: 4px;
	}

	.gap.is-open {
		height: 28px;
	}

	.gap__line {
		position: absolute;
		inset-inline: 0;
		top: 50%;
		height: 2px;
		border-radius: 2px;
		background: transparent;
	}

	.gap.is-target .gap__line {
		background: var(--primary);
	}

	.gap__label {
		position: relative;
		padding: 0 8px;
		background: var(--bg-card);
		color: var(--text-muted);
		font-size: var(--fs-small);
		opacity: 0;
	}

	.gap.is-target .gap__label {
		color: var(--text-primary);
		opacity: 1;
	}

	/* A row is a quiet frame with a small bar: its grip, its name and its column count. */
	.row {
		display: grid;
		gap: 3px;
		padding: 3px 8px 8px;
		border: 1px solid var(--border-subtle);
		border-radius: var(--radius-panel);
		background: var(--bg-subtle);
	}

	.row__bar {
		display: flex;
		align-items: center;
		gap: 4px;
		min-height: 22px;
		color: var(--text-muted);
		font-size: var(--fs-small);
	}

	.row__grip {
		display: grid;
		place-items: center;
		width: 20px;
		height: 20px;
		border-radius: var(--radius-xs);
		cursor: grab;
		--icon-size: var(--icon-sm);
	}

	.row__grip:hover {
		background: var(--bg-hover);
		color: var(--text-primary);
	}

	.row.is-selected {
		border-color: var(--primary);
		box-shadow: 0 0 0 1px var(--primary);
	}

	.row__name {
		flex: 1;
		min-width: 0;
	}

	.row__name button {
		padding: 1px 6px;
		border: 0;
		border-radius: var(--radius-xs);
		background: transparent;
		color: inherit;
		font: inherit;
	}

	.row__name button:hover:not(:disabled),
	.row__name button[aria-pressed='true'] {
		background: var(--bg-hover);
		color: var(--text-primary);
	}

	/* Keeps its full hit area without making the bar taller. */
	.row__remove {
		margin-block: -6px;
	}

	/* Column count, each button drawn as the layout it gives. */
	.row__switch {
		display: flex;
		gap: 1px;
		padding: 1px;
		border: 1px solid var(--border);
		border-radius: var(--radius-control);
		background: var(--bg-card);
	}

	/* Low but wide, so the bar stays short and the buttons stay easy to hit. */
	.row__switch button {
		display: grid;
		place-items: center;
		width: 28px;
		height: 18px;
		padding: 0;
		border: 0;
		border-radius: var(--radius-xs);
		background: transparent;
		color: var(--text-muted);
	}

	.row__switch button:hover:not(:disabled) {
		color: var(--text-primary);
	}

	.row__switch button[aria-pressed='true'] {
		background: var(--bg-hover);
		color: var(--text-primary);
	}

	.glyph {
		display: flex;
		gap: 2px;
		width: 16px;
		height: 10px;
	}

	.glyph i {
		flex: 1;
		border: 1.5px solid currentColor;
		border-radius: 2px;
	}

	.row__cols {
		display: grid;
		grid-template-columns: repeat(var(--cols), minmax(0, 1fr));
		gap: 8px;
	}

	.col {
		display: flex;
		flex-direction: column;
		gap: 6px;
		min-width: 0;
		min-height: 52px;
		border-radius: var(--radius-control);
	}

	/* Several columns: each shows its slot, so where things go is visible before dragging. */
	.row__cols--multi .col {
		padding: 4px;
		border: 1px dashed var(--border-strong);
	}

	.col.is-target {
		background: var(--bg-hover);
	}

	.col__empty {
		display: grid;
		flex: 1;
		place-items: center;
		margin: 0;
		padding: 10px;
		color: var(--text-muted);
		font-size: var(--fs-caption);
		text-align: center;
	}

	.col.is-empty.is-target .col__empty {
		color: var(--text-primary);
	}

	.drop-line {
		height: 2px;
		margin: -4px 0;
		border-radius: 2px;
		background: var(--primary);
	}

	.part {
		display: flex;
		align-items: center;
		gap: 4px;
		min-width: 0;
		padding: 6px 6px 6px 4px;
		border: 1px solid var(--border);
		border-radius: var(--radius-control);
		background: var(--bg-card);
		cursor: grab;
	}

	/* New or changed since saving. */
	.part.is-changed {
		border-color: var(--changed-edge);
		background: linear-gradient(var(--changed-bg), var(--changed-bg)), var(--bg-card);
	}

	.part.is-selected {
		border-color: var(--primary);
		box-shadow: 0 0 0 1px var(--primary);
	}

	.part__grip {
		display: grid;
		flex-shrink: 0;
		place-items: center;
		width: 18px;
		color: var(--text-muted);
		--icon-size: var(--icon-sm);
	}

	.part__main {
		display: grid;
		flex: 1;
		min-width: 0;
		gap: 2px;
		padding: 4px 6px;
		border: 0;
		border-radius: var(--radius-xs);
		background: transparent;
		color: var(--text-primary);
		text-align: start;
	}

	.part__role {
		font-size: var(--fs-body);
		font-weight: var(--fw-medium);
		overflow-wrap: anywhere;
	}

	.part__main small {
		color: var(--text-muted);
		font-size: var(--fs-small);
		overflow-wrap: anywhere;
	}

	@media (prefers-reduced-motion: reduce) {
		.gap {
			transition: none;
		}
	}
</style>
