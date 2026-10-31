<script module lang="ts">
	export type ConflictChoice = 'reload' | 'overwrite' | 'cancel';
</script>

<script lang="ts">
	import { t } from '$lib/i18n/i18n.svelte';
	import Button from '$lib/ui/primitives/Button.svelte';

	/**
	 * Saving found that another admin saved first. Says what they changed and lets the admin
	 * choose: take the latest values (their own changes go), or save their own changes on top
	 * (only what they changed). Closing keeps everything unsaved, as it was. Never decided
	 * silently: overwriting someone's work is a choice the admin makes knowingly.
	 */
	interface Props {
		open: boolean;
		/** Names of the settings the other admin changed. */
		changed: readonly string[];
		onchoose: (choice: ConflictChoice) => void;
	}

	let { open, changed, onchoose }: Props = $props();

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
		onchoose('cancel');
	}}
>
	<h2 id="{uid}-title">{t('settings.conflict.title')}</h2>
	<p id="{uid}-body">{t('settings.conflict.body')}</p>
	{#if changed.length > 0}
		<ul class="dialog__list">
			{#each changed as name (name)}<li>{name}</li>{/each}
		</ul>
	{/if}
	<div class="dialog__choices">
		<div class="choice">
			<Button variant="primary" onclick={() => onchoose('reload')}>
				{t('settings.conflict.reload')}
			</Button>
			<span>{t('settings.conflict.reload.desc')}</span>
		</div>
		<div class="choice">
			<Button onclick={() => onchoose('overwrite')}>{t('settings.conflict.overwrite')}</Button>
			<span>{t('settings.conflict.overwrite.desc')}</span>
		</div>
	</div>
	<div class="dialog__actions">
		<Button variant="ghost" onclick={() => onchoose('cancel')}>{t('common.cancel')}</Button>
	</div>
</dialog>

<style>
	.dialog {
		width: min(480px, calc(100vw - 32px));
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
		margin: 0;
		color: var(--text-secondary);
		font-size: var(--fs-body);
		line-height: var(--lh-relaxed);
	}

	.dialog__list {
		display: grid;
		gap: 2px;
		margin: 8px 0 0;
		padding-inline-start: 1.25em;
		font-size: var(--fs-body);
	}

	.dialog__choices {
		display: grid;
		gap: 12px;
		margin-top: 20px;
	}

	/* Each choice with what it does, so the admin does not have to guess. */
	.choice {
		display: grid;
		justify-items: start;
		gap: 4px;
		color: var(--text-muted);
		font-size: var(--fs-caption);
	}

	.dialog__actions {
		display: flex;
		justify-content: flex-end;
		margin-top: 16px;
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
