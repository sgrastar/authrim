<script lang="ts">
	import ConfirmDialog from './ConfirmDialog.svelte';
	import Button from '../primitives/Button.svelte';

	/**
	 * Irreversible actions, kept at the end of a page and always behind a confirmation.
	 */
	interface Props {
		title: string;
		description: string;
		actionLabel: string;
		confirmTitle: string;
		confirmBody: string;
		onconfirm: () => Promise<void> | void;
	}

	let { title, description, actionLabel, confirmTitle, confirmBody, onconfirm }: Props = $props();

	let open = $state(false);
	let busy = $state(false);

	async function confirm() {
		busy = true;
		try {
			await onconfirm();
			open = false;
		} finally {
			busy = false;
		}
	}
</script>

<section class="danger">
	<div class="danger__text">
		<h2>{title}</h2>
		<p>{description}</p>
	</div>
	<Button variant="danger" icon="trash" onclick={() => (open = true)}>{actionLabel}</Button>
</section>

<ConfirmDialog
	{open}
	{busy}
	tone="danger"
	title={confirmTitle}
	body={confirmBody}
	confirmLabel={actionLabel}
	onconfirm={confirm}
	oncancel={() => (open = false)}
/>

<style>
	.danger {
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		gap: 12px 18px;
		padding: var(--box-head-pad-y) var(--box-pad);
		border: 1px solid color-mix(in srgb, var(--danger) 40%, var(--border));
		border-radius: var(--radius-panel);
		background: var(--surface-bg);
	}

	.danger__text {
		min-width: 0;
		flex: 1 1 260px;
	}

	h2 {
		margin: 0;
		font-size: var(--fs-heading);
		font-weight: var(--fw-semibold);
		color: var(--danger);
	}

	p {
		margin: 3px 0 0;
		font-size: var(--fs-label);
		color: var(--text-secondary);
	}
</style>
