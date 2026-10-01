<script lang="ts">
	import type { Snippet } from 'svelte';
	import { t } from '$lib/i18n/i18n.svelte';
	import { provideBusy } from '../busy/busy';
	import Button from '../primitives/Button.svelte';
	import Callout from './Callout.svelte';

	/**
	 * Modal with a few fields (name something, confirm a value). Built on <dialog>: focus stays
	 * inside, Esc cancels, Enter submits the form.
	 */
	interface Props {
		open: boolean;
		title: string;
		description?: string;
		submitLabel: string;
		busy?: boolean;
		/** Why the last submit failed. Shown inside the dialog, which stays open for a retry. */
		error?: string;
		onsubmit: () => void;
		oncancel: () => void;
		children: Snippet;
	}

	let {
		open,
		title,
		description,
		submitLabel,
		busy = false,
		error,
		onsubmit,
		oncancel,
		children
	}: Props = $props();

	// While the action runs, the fields and the cancel button wait for it.
	provideBusy(() => busy);

	let dialog = $state<HTMLDialogElement>();
	const uid = $props.id();

	$effect(() => {
		if (!dialog) return;
		if (open && !dialog.open) dialog.showModal();
		if (!open && dialog.open) dialog.close();
	});
</script>

<dialog
	bind:this={dialog}
	class="dialog"
	aria-labelledby="{uid}-title"
	oncancel={(event) => {
		event.preventDefault();
		if (!busy) oncancel();
	}}
>
	<form
		onsubmit={(event) => {
			event.preventDefault();
			if (!busy) onsubmit();
		}}
	>
		<h2 id="{uid}-title">{title}</h2>
		{#if description}<p>{description}</p>{/if}
		<div class="dialog__fields">
			{@render children()}
			{#if error}<Callout tone="danger" live>{error}</Callout>{/if}
		</div>
		<div class="dialog__actions">
			<Button variant="ghost" onclick={oncancel}>{t('common.cancel')}</Button>
			<Button variant="primary" type="submit" loading={busy}>{submitLabel}</Button>
		</div>
	</form>
</dialog>

<style>
	.dialog {
		width: min(440px, calc(100vw - 32px));
		padding: var(--dialog-pad-y) var(--dialog-pad-x);
		border: 1px solid var(--border);
		border-radius: var(--radius-panel);
		background: var(--bg-card);
		color: var(--text-primary);
		box-shadow: var(--shadow-lg);
	}

	.dialog[open] {
		animation: dialog-in 160ms cubic-bezier(0.2, 0.9, 0.3, 1) both;
	}

	.dialog::backdrop {
		background: var(--scrim);
	}

	h2 {
		margin: 0 0 6px;
		font-size: var(--fs-title);
		font-weight: var(--fw-semibold);
	}

	p {
		margin: 0;
		font-size: var(--fs-body);
		line-height: var(--lh-body);
		color: var(--text-secondary);
	}

	.dialog__fields {
		display: grid;
		gap: var(--space-field);
		margin: 16px 0 20px;
	}

	.dialog__actions {
		display: flex;
		justify-content: flex-end;
		gap: 8px;
	}

	@keyframes dialog-in {
		from {
			opacity: 0;
			transform: translateY(8px) scale(0.98);
		}
	}

	@media (prefers-reduced-motion: reduce) {
		.dialog[open] {
			animation: none;
		}
	}
</style>
