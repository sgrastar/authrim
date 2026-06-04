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
				<button class="icon-button" type="button" aria-label={$LL.common_close()} onclick={onCancel}
					>x</button
				>
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
		z-index: 50;
		display: grid;
		place-items: center;
		padding: 20px;
		background: rgba(17, 24, 39, 0.48);
	}
	.modal {
		width: min(100%, 460px);
		border-radius: 8px;
		background: #fff;
		box-shadow: 0 20px 60px rgba(15, 23, 42, 0.24);
	}
	.modal-header,
	.modal-actions {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: 12px;
		padding: 16px 18px;
		border-bottom: 1px solid #e5e7eb;
	}
	.modal-actions {
		justify-content: flex-end;
		border-top: 1px solid #e5e7eb;
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
		font-weight: 600;
	}
	.muted {
		color: #6b7280;
	}
	code {
		display: block;
		padding: 10px 12px;
		border-radius: 6px;
		background: #f3f4f6;
		font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
		overflow-wrap: anywhere;
	}
	input {
		border: 1px solid #d1d5db;
		border-radius: 6px;
		padding: 9px 10px;
		font: inherit;
	}
	.icon-button {
		width: 32px;
		height: 32px;
		border: 0;
		border-radius: 999px;
		background: #f3f4f6;
		cursor: pointer;
	}
	.btn {
		border: 0;
		border-radius: 6px;
		padding: 9px 14px;
		cursor: pointer;
	}
	.btn:disabled {
		cursor: not-allowed;
		opacity: 0.55;
	}
	.btn-secondary {
		background: #eee;
	}
	.btn-danger {
		background: #b91c1c;
		color: #fff;
	}
</style>
