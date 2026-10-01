<script lang="ts">
	import { t } from '$lib/i18n/i18n.svelte';
	import { provideBusy } from '../busy/busy';
	import Button from '../primitives/Button.svelte';

	/**
	 * Modal confirmation built on <dialog>: focus is trapped and Esc closes it natively.
	 * Use for actions that discard work or cannot be undone.
	 */
	interface Props {
		open: boolean;
		title: string;
		body: string;
		confirmLabel: string;
		/** Label of the button that keeps things as they are (default "Cancel"). */
		cancelLabel?: string;
		tone?: 'default' | 'danger';
		busy?: boolean;
		onconfirm: () => void;
		oncancel: () => void;
	}

	let {
		open,
		title,
		body,
		confirmLabel,
		cancelLabel,
		tone = 'default',
		busy = false,
		onconfirm,
		oncancel
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
	aria-describedby="{uid}-body"
	oncancel={(event) => {
		event.preventDefault();
		if (!busy) oncancel();
	}}
>
	<h2 id="{uid}-title">{title}</h2>
	<p id="{uid}-body">{body}</p>
	<div class="dialog__actions">
		<Button variant="ghost" onclick={oncancel}>{cancelLabel ?? t('common.cancel')}</Button>
		<Button variant={tone === 'danger' ? 'danger' : 'primary'} loading={busy} onclick={onconfirm}>
			{confirmLabel}
		</Button>
	</div>
</dialog>

<style>
	.dialog {
		width: min(420px, calc(100vw - 32px));
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
		margin: 0 0 8px;
		font-size: var(--fs-title);
		font-weight: var(--fw-semibold);
	}

	p {
		margin: 0 0 20px;
		font-size: var(--fs-body);
		line-height: var(--lh-relaxed);
		color: var(--text-secondary);
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
