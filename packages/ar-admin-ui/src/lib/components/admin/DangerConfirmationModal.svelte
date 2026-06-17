<script lang="ts">
	import { LL } from '$i18n/i18n-svelte';

	interface Props {
		open: boolean;
		title: string;
		resourceName: string;
		phrase: string;
		confirmLabel?: string;
		onConfirm: (value: string) => void;
		onCancel: () => void;
	}

	let { open, title, resourceName, phrase, confirmLabel, onConfirm, onCancel }: Props = $props();
	let value = $state('');

	$effect(() => {
		if (open) {
			value = '';
		}
	});

	function submit() {
		const confirmation = value.trim();
		if (confirmation === phrase) {
			onConfirm(confirmation);
		}
	}
</script>

{#if open}
	<div class="modal-backdrop" role="presentation">
		<div class="modal" role="dialog" aria-modal="true" aria-labelledby="danger-modal-title">
			<div class="modal-header">
				<h2 id="danger-modal-title">{title}</h2>
				<button
					class="icon-button"
					type="button"
					aria-label={$LL.common_close()}
					onclick={onCancel}
				>
					<i class="i-ph-x"></i>
				</button>
			</div>
			<div class="modal-body">
				<p class="resource-name">{resourceName}</p>
				<p class="muted">{$LL.common_confirmation_phrase_instruction()}</p>
				<code>{phrase}</code>
				<input
					bind:value
					autocomplete="off"
					placeholder={$LL.common_confirmation_phrase_placeholder()}
				/>
			</div>
			<div class="modal-actions">
				<button class="btn btn-secondary" type="button" onclick={onCancel}
					>{$LL.common_cancel()}</button
				>
				<button
					class="btn btn-danger"
					type="button"
					onclick={submit}
					disabled={value.trim() !== phrase}
				>
					{confirmLabel ?? $LL.common_confirm()}
				</button>
			</div>
		</div>
	</div>
{/if}

<style>
	.modal-backdrop {
		position: fixed;
		inset: 0;
		z-index: var(--z-modal-backdrop, 50);
		display: grid;
		place-items: center;
		padding: 20px;
		background: var(--color-overlay-scrim);
		backdrop-filter: blur(var(--overlay-blur, 6px));
	}
	.modal {
		width: min(100%, 460px);
		border: 1px solid var(--color-border);
		border-radius: var(--radius-panel, 8px);
		background: var(--modal-bg, var(--color-surface));
		color: var(--color-text);
		box-shadow: var(--modal-shadow, var(--shadow-panel));
	}
	.modal-header,
	.modal-actions {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: 12px;
		padding: 16px 18px;
		border-bottom: 1px solid var(--color-border);
	}
	.modal-actions {
		justify-content: flex-end;
		border-top: 1px solid var(--color-border);
		border-bottom: 0;
	}
	h2,
	p {
		margin: 0;
	}
	.modal-body {
		display: grid;
		gap: 12px;
		padding: 18px;
	}
	.resource-name {
		color: var(--color-heading, var(--color-text));
		font-weight: var(--font-weight-semibold, 600);
	}
	.muted {
		color: var(--color-text-muted);
	}
	code {
		display: block;
		padding: 10px 12px;
		border: 1px solid var(--color-border);
		border-radius: var(--radius-control, 6px);
		background: var(--color-surface-muted);
		color: var(--color-text);
		font-family: var(--font-mono, ui-monospace, SFMono-Regular, Menlo, monospace);
		overflow-wrap: anywhere;
	}
	input {
		min-height: var(--control-height, 40px);
		border: var(--control-border, 1px solid var(--color-border));
		border-radius: var(--radius-control, 6px);
		padding: var(--control-padding, 9px 10px);
		background: var(--control-bg, var(--color-surface));
		color: var(--color-text);
		box-shadow: var(--control-shadow, none);
		font: inherit;
	}
	input:focus {
		outline: none;
		border-color: var(--control-focus-border, var(--color-danger));
		box-shadow: var(--control-focus-shadow, 0 0 0 3px var(--color-accent-muted));
	}
	.icon-button {
		display: inline-flex;
		align-items: center;
		justify-content: center;
		width: 32px;
		height: 32px;
		border: 1px solid transparent;
		border-radius: var(--radius-control, 6px);
		background: transparent;
		color: var(--color-text-muted);
		cursor: pointer;
	}
	.icon-button :global(i) {
		width: 16px;
		height: 16px;
		font-size: 16px;
	}
	.icon-button:hover {
		border-color: var(--color-border);
		background: var(--color-surface-muted);
		color: var(--color-text);
	}
	.btn {
		border: 1px solid transparent;
		border-radius: var(--radius-control, 6px);
		padding: 9px 14px;
		font-weight: var(--font-weight-semibold, 600);
		cursor: pointer;
		transition:
			background 0.15s ease,
			border-color 0.15s ease,
			color 0.15s ease;
	}
	.btn:disabled {
		cursor: not-allowed;
		opacity: 0.55;
	}
	.btn-secondary {
		border-color: var(--color-border);
		background: var(--color-surface);
		color: var(--color-text);
	}
	.btn-secondary:hover {
		border-color: var(--color-border-strong);
		background: var(--color-surface-muted);
	}
	.btn-danger {
		border-color: var(--color-danger);
		background: var(--color-danger);
		color: var(--color-accent-contrast);
	}
	.btn-danger:hover:not(:disabled) {
		background: color-mix(in srgb, var(--color-danger) 88%, var(--color-text));
		border-color: color-mix(in srgb, var(--color-danger) 88%, var(--color-text));
	}
</style>
