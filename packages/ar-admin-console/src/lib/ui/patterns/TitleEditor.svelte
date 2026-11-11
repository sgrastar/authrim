<script lang="ts">
	import { onMount } from 'svelte';
	import { t } from '#lib/i18n/i18n.svelte.js';
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
		maxlength?: number;
		doneLabel: string;
		ondone: (value: string) => void;
		oncancel: () => void;
	}

	let {
		value,
		label,
		hint,
		requiredMessage,
		maxlength = 80,
		doneLabel,
		ondone,
		oncancel
	}: Props = $props();

	const uid = $props.id();
	// What is typed, from the title it opened with.
	// svelte-ignore state_referenced_locally
	let draft = $state(value);
	let error = $state('');
	let input = $state<HTMLInputElement>();

	onMount(() => {
		input?.focus();
		input?.select();
	});

	function done() {
		const trimmed = draft.trim();
		if (!trimmed) {
			error = requiredMessage;
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
			{maxlength}
			aria-required="true"
			aria-invalid={error ? 'true' : undefined}
			aria-describedby={error || hint ? `${uid}-note` : undefined}
			oninput={() => (error = '')}
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
	{#if error}
		<p id="{uid}-note" class="title-editor__error" role="alert">{error}</p>
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
