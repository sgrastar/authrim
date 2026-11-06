<script lang="ts">
	import { t } from '#lib/i18n/i18n.svelte.js';
	import Button from '#lib/ui/primitives/Button.svelte';
	import KeyringPresentationPanel from './KeyringPresentationPanel.svelte';
	import type { KeyringPresentationFlow } from './presentation-flow.svelte.js';

	/**
	 * A modal around one Keyring presentation (e.g. registering Keyring as a second factor). The
	 * caller owns the flow and closes the dialog when it is verified.
	 */
	interface Props {
		open: boolean;
		title: string;
		description?: string;
		flow: KeyringPresentationFlow | null;
		onretry: () => void;
		oncancel: () => void;
	}

	let { open, title, description, flow, onretry, oncancel }: Props = $props();

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
		oncancel();
	}}
>
	<h2 id="{uid}-title">{title}</h2>
	{#if description}<p>{description}</p>{/if}
	<div class="dialog__body">
		{#if open && flow}
			<KeyringPresentationPanel {flow} {onretry} />
		{/if}
	</div>
	<div class="dialog__actions">
		<Button variant="ghost" onclick={oncancel}>{t('common.cancel')}</Button>
	</div>
</dialog>

<style>
	.dialog {
		width: min(560px, calc(100vw - 32px));
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

	.dialog__body {
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
