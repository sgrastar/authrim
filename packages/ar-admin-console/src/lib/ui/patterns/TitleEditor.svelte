<script lang="ts">
	import { onMount, untrack } from 'svelte';
	import { t } from '#lib/i18n/i18n.svelte.js';
	import { useBusy } from '../busy/busy';
	import Button from '../primitives/Button.svelte';

	/**
	 * Editing a title in place of it (a header's `titleEditor`): a field holding the title, Done
	 * and Cancel. Done with an empty title says so and keeps editing; Escape cancels. The field is
	 * focused, its text selected, when it opens. The way a sign-in method profile's name is edited.
	 */
	interface Props {
		value: string;
		/** The field's name for screen readers ("Title"). */
		label: string;
		/** Under the field: what the title is for. */
		hint?: string;
		/** Shown when Done is pressed with nothing in the field. */
		requiredMessage: string;
		/**
		 * A problem the page found with the title (taken by another, missing when Save was
		 * pressed), shown under the field. The page clears it (typically from `oninput`) and
		 * takes the admin to the field with `focus()`.
		 */
		error?: string;
		/**
		 * Done was pressed with nothing in the field. Given, the page shows the problem itself
		 * (through `error`), so it knows about it too; otherwise the editor shows `requiredMessage`.
		 */
		onrequired?: () => void;
		maxlength?: number;
		doneLabel: string;
		ondone: (value: string) => void;
		/** Each change while typing, for a page that keeps the typed name as unsaved work. */
		oninput?: (value: string) => void;
		oncancel: () => void;
	}

	let {
		value,
		label,
		hint,
		requiredMessage,
		error: pageError = '',
		maxlength = 80,
		doneLabel,
		ondone,
		onrequired,
		oninput,
		oncancel
	}: Props = $props();

	const uid = $props.id();
	// What is typed, from the title it opened with.
	// svelte-ignore state_referenced_locally
	let draft = $state(value);
	let error = $state('');
	let input = $state<HTMLInputElement>();
	// While the page saves nothing can be typed: what is typed then would not be saved.
	const busy = useBusy();
	// A title changed from outside while open (the page discarded its changes) is shown here too.
	$effect(() => {
		const next = value;
		untrack(() => {
			if (next !== draft) {
				draft = next;
				error = '';
			}
		});
	});

	onMount(() => {
		input?.focus();
		input?.select();
	});
	/** Takes the admin to the field (after a problem the page found). */
	export function focus(): void {
		input?.focus();
	}
	const shownError = $derived(error || pageError);

	function done() {
		const trimmed = draft.trim();
		if (!trimmed) {
			if (onrequired) onrequired();
			else error = requiredMessage;
			input?.focus();
			return;
		}
		ondone(trimmed);
	}
</script>

<form
	class="title-editor"
	onsubmit={(event) => {
		event.preventDefault();
		done();
	}}
>
	<div class="title-editor__row">
		<label class="sr-only" for="{uid}-title">{label}</label>
		<input
			id="{uid}-title"
			bind:this={input}
			bind:value={draft}
			disabled={busy()}
			{maxlength}
			aria-required="true"
			aria-invalid={shownError ? 'true' : undefined}
			aria-describedby={shownError || hint ? `${uid}-note` : undefined}
			oninput={() => {
				error = '';
				oninput?.(draft);
			}}
			onkeydown={(event) => {
				if (event.key === 'Escape') {
					event.preventDefault();
					oncancel();
				}
			}}
		/>
		<Button type="submit" variant="primary" size="sm">{doneLabel}</Button>
		<Button variant="ghost" size="sm" onclick={oncancel}>{t('common.cancel')}</Button>
	</div>
	{#if shownError}
		<p id="{uid}-note" class="title-editor__error" role="alert">{shownError}</p>
	{:else if hint}
		<p id="{uid}-note" class="title-editor__hint">{hint}</p>
	{/if}
</form>

<style>
	.title-editor {
		width: min(100%, 520px);
	}

	.title-editor__row {
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		gap: 6px;
	}

	.title-editor input {
		flex: 1 1 210px;
		min-width: 0;
		height: calc(var(--fs-title) * 1.8);
		padding: 0 10px;
		border: 1px solid var(--border-strong);
		border-radius: var(--radius-control);
		background: var(--bg-input);
		color: var(--text-primary);
		font: inherit;
	}

	.title-editor__hint,
	.title-editor__error {
		margin: 5px 0 0;
		font-size: var(--fs-small);
	}

	.title-editor__hint {
		color: var(--text-muted);
	}

	.title-editor__error {
		color: var(--danger);
	}
</style>
