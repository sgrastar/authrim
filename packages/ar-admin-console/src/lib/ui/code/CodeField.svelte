<script lang="ts">
	import type { Snippet } from 'svelte';
	import { t } from '$lib/i18n/i18n.svelte';
	import Checkbox from '../primitives/Checkbox.svelte';
	import { useBusy } from '../busy/busy';
	import CopyButton from '../primitives/CopyButton.svelte';
	import { highlight, type CodeLanguage, type Token } from './highlight';

	/**
	 * Code input with syntax highlighting (JSON, JavaScript, CSS, XML, shell).
	 * A transparent native <textarea> sits exactly over the coloured copy, so typing, selection,
	 * undo, IME and screen readers behave like a normal text field. Tab moves focus as usual.
	 *
	 * Line numbers are drawn inside each line of the coloured copy (not in a separate column), so
	 * they stay next to their line when long lines wrap; the textarea is indented by the same
	 * gutter width so both wrap at exactly the same point.
	 */
	interface Props {
		label: string;
		language: CodeLanguage;
		value?: string;
		rows?: number;
		hint?: string;
		error?: string;
		required?: boolean;
		readonly?: boolean;
		placeholder?: string;
		lineNumbers?: boolean;
		/** Wrap long lines instead of scrolling sideways. */
		wrap?: boolean;
		/** Let the viewer switch wrapping with a checkbox above the field. */
		wrapToggle?: boolean;
		/** Show a copy button above the field. */
		copyable?: boolean;
		/** More controls aligned with the label (e.g. Format). */
		actions?: Snippet;
		/** Status line under the field, replacing the hint. */
		status?: Snippet;
	}

	let {
		label,
		language,
		value = $bindable(''),
		rows = 10,
		hint,
		error,
		required = false,
		readonly = false,
		placeholder,
		lineNumbers = true,
		wrap = $bindable(false),
		wrapToggle = false,
		copyable = false,
		actions,
		status
	}: Props = $props();

	const uid = $props.id();
	const id = `code-${uid}`;
	const busy = useBusy();
	let view = $state<HTMLDivElement>();

	/** Tokens split into lines; a token spanning a newline is cut at it. */
	const lines = $derived.by(() => {
		const out: Token[][] = [[]];
		for (const token of highlight(value, language)) {
			const parts = token.text.split('\n');
			parts.forEach((part, index) => {
				if (index > 0) out.push([]);
				if (part) out[out.length - 1].push({ type: token.type, text: part });
			});
		}
		return out;
	});
	const digits = $derived(String(lines.length).length);
	const describedBy = $derived(
		[hint || status ? `${id}-hint` : '', error ? `${id}-error` : ''].filter(Boolean).join(' ') ||
			undefined
	);

	function sync(event: Event & { currentTarget: HTMLTextAreaElement }) {
		if (!view) return;
		view.scrollTop = event.currentTarget.scrollTop;
		view.scrollLeft = event.currentTarget.scrollLeft;
	}
</script>

<div class="code-field" class:has-error={!!error} class:is-busy={busy()}>
	<div class="code-field__top">
		<label class="code-field__label" for={id}>
			{label}
			{#if required}<span class="code-field__req" aria-hidden="true">*</span>{/if}
		</label>
		{#if actions || wrapToggle || copyable}
			<div class="code-field__actions">
				{#if wrapToggle}<Checkbox bind:checked={wrap}>{t('code.wrap')}</Checkbox>{/if}
				{#if actions}{@render actions()}{/if}
				{#if copyable}<CopyButton text={() => value} label={`${t('copy.copy')}: ${label}`} />{/if}
			</div>
		{/if}
	</div>

	<div
		class="code"
		class:code--wrap={wrap}
		style:--rows={rows}
		style:--gutter-w={lineNumbers ? `calc(${Math.max(2, digits)}ch + 20px)` : '0px'}
	>
		<div class="code__view" aria-hidden="true" bind:this={view}>
			{#each lines as line, index (index)}
				<div class="code__line">
					{#if lineNumbers}<span class="code__ln">{index + 1}</span>{/if}<span class="code__lc"
						>{#each line as token, k (k)}{#if token.type === 'text'}{token.text}{:else}<span
									class="tok tok--{token.type}">{token.text}</span
								>{/if}{/each}</span
					>
				</div>
			{/each}
		</div>
		<textarea
			{id}
			class="code__input"
			bind:value
			{required}
			readonly={readonly || busy()}
			{placeholder}
			spellcheck="false"
			autocomplete="off"
			autocapitalize="off"
			wrap={wrap ? 'soft' : 'off'}
			aria-invalid={error ? 'true' : undefined}
			aria-describedby={describedBy}
			onscroll={sync}
		></textarea>
	</div>

	{#if status}
		<div class="code-field__hint" id="{id}-hint">{@render status()}</div>
	{:else if hint}
		<p class="code-field__hint" id="{id}-hint">{hint}</p>
	{/if}
	{#if error}<p class="code-field__error" id="{id}-error" role="alert">{error}</p>{/if}
</div>

<style>
	.code-field {
		display: grid;
		gap: 5px;
		--code-line: 1.6;
		--code-size: 12.5px;
		--code-pad: 9px;
	}

	.code-field__top {
		display: flex;
		flex-wrap: wrap;
		align-items: flex-end;
		justify-content: space-between;
		gap: 6px 10px;
		min-height: 26px;
	}

	.code-field__label {
		font-size: var(--fs-label);
		font-weight: var(--fw-semibold);
		color: var(--text-secondary);
	}

	.code-field__req {
		margin-inline-start: 3px;
		color: var(--danger);
	}

	.code-field__actions {
		display: flex;
		align-items: center;
		gap: 12px;
	}

	.code {
		position: relative;
		height: calc(var(--rows) * var(--code-size) * var(--code-line) + var(--code-pad) * 2 + 2px);
		min-height: 80px;
		overflow: hidden;
		border: 1px solid var(--border-strong);
		border-radius: var(--radius-control);
		/* The gutter colour runs the full height, even below the last line. */
		background: linear-gradient(
			to right,
			var(--bg-subtle) var(--gutter-w),
			var(--bg-input) var(--gutter-w)
		);
		/* Code reads left to right even inside right-to-left pages. */
		direction: ltr;
		/* --gutter-w is in ch, resolved per element: every user of it needs the same font. */
		font-family: var(--font-mono);
		font-size: var(--code-size);
		resize: vertical;
	}

	.code:focus-within {
		border-color: var(--focus-ring);
		outline: 2px solid color-mix(in srgb, var(--focus-ring) 35%, transparent);
	}

	/* Quieter surface, not transparency: the code must stay readable (AA). */
	.is-busy .code {
		background: var(--bg-subtle);
	}

	.is-busy .code__input {
		cursor: progress;
	}

	.has-error .code {
		border-color: var(--danger);
	}

	/* View and input share every metric (font, line height, padding, scrollbar space) so each
	   character, and each wrap point, lines up exactly. */
	.code__view,
	.code__input {
		position: absolute;
		inset: 0;
		margin: 0;
		border: 0;
		font-family: var(--font-mono);
		font-size: var(--code-size);
		line-height: var(--code-line);
		letter-spacing: 0;
		tab-size: 2;
		scrollbar-gutter: stable;
	}

	.code__view {
		padding: var(--code-pad) 0;
		overflow: hidden;
		color: var(--text-primary);
		pointer-events: none;
	}

	.code__line {
		display: flex;
		width: max-content;
		min-width: 100%;
	}

	.code--wrap .code__line {
		width: 100%;
	}

	.code__ln {
		position: sticky;
		left: 0;
		flex-shrink: 0;
		width: var(--gutter-w);
		padding-right: 10px;
		border-right: 1px solid var(--border-subtle);
		background: var(--bg-subtle);
		color: var(--text-muted);
		text-align: right;
		user-select: none;
	}

	.code__lc {
		min-width: 0;
		flex: 1;
		padding: 0 10px;
		white-space: pre;
	}

	/* Keep an empty line one line tall. */
	.code__lc:empty::after {
		content: '\200b';
	}

	.code--wrap .code__lc {
		white-space: pre-wrap;
		overflow-wrap: anywhere;
	}

	.code__input {
		width: 100%;
		height: 100%;
		padding: var(--code-pad) 10px var(--code-pad) calc(var(--gutter-w) + 10px);
		overflow: auto;
		background: transparent;
		color: transparent;
		caret-color: var(--text-primary);
		white-space: pre;
		resize: none;
		outline: none;
	}

	.code--wrap .code__input {
		white-space: pre-wrap;
		overflow-wrap: anywhere;
	}

	.code__input::placeholder {
		color: var(--text-muted);
	}

	.code__input::selection {
		background: color-mix(in srgb, var(--focus-ring) 30%, transparent);
		color: transparent;
	}

	.tok--comment {
		color: var(--code-comment);
		font-style: italic;
	}
	.tok--string {
		color: var(--code-string);
	}
	.tok--number {
		color: var(--code-number);
	}
	.tok--keyword {
		color: var(--code-keyword);
	}
	.tok--literal {
		color: var(--code-literal);
	}
	.tok--property {
		color: var(--code-property);
	}
	.tok--tag {
		color: var(--code-tag);
	}
	.tok--attr {
		color: var(--code-attr);
	}
	.tok--function {
		color: var(--code-function);
	}
	.tok--variable {
		color: var(--code-variable);
	}
	.tok--punct {
		color: var(--code-punct);
	}

	.code-field__hint,
	.code-field__error {
		margin: 0;
		font-size: var(--fs-caption);
	}

	.code-field__hint {
		color: var(--text-muted);
	}

	.code-field__error {
		color: var(--danger);
	}
</style>
