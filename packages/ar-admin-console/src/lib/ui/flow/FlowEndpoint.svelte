<script lang="ts">
	import Icon from '../icons/Icon.svelte';

	/**
	 * Start or end of a flow. `external` is the party Authrim talks to; `authrim` is Authrim's own
	 * side (one shade lower so the two read apart); `locked` is a tenant-owned endpoint that
	 * cannot be edited from here.
	 */
	interface Props {
		kind?: 'external' | 'authrim' | 'locked';
		title: string;
		detail: string;
		/** Makes the endpoint a button (e.g. open the connection overview). */
		onselect?: () => void;
		/** Accessible name when interactive. */
		actionLabel?: string;
	}

	let { kind = 'external', title, detail, onselect, actionLabel }: Props = $props();
</script>

{#snippet body()}
	<span class="endpoint__symbol" aria-hidden="true">
		{#if kind === 'locked'}<Icon name="lock" />{:else if kind === 'authrim'}DB{:else}<Icon
				name="external"
			/>{/if}
	</span>
	<span class="endpoint__text">
		<strong>{title}</strong>
		<small>{detail}</small>
	</span>
{/snippet}

<div class="endpoint-item">
	{#if onselect}
		<button
			type="button"
			class="endpoint endpoint--{kind} endpoint--link"
			aria-label={actionLabel}
			onclick={onselect}>{@render body()}</button
		>
	{:else}
		<div class="endpoint endpoint--{kind}">{@render body()}</div>
	{/if}
</div>

<style>
	.endpoint-item {
		display: flex;
		justify-content: center;
		width: 100%;
	}

	.endpoint {
		display: flex;
		align-items: center;
		gap: 11px;
		width: var(--flow-node-w);
		min-height: 64px;
		padding: 13px;
		border: 1px solid var(--border);
		border-radius: min(8px, var(--radius-panel));
		background: var(--bg-card);
		color: inherit;
		font: inherit;
		text-align: start;
	}

	.endpoint--authrim {
		border-color: var(--border-strong);
		background: var(--bg-subtle);
	}

	.endpoint--locked {
		border-style: dashed;
		background: transparent;
	}

	.endpoint--link {
		cursor: pointer;
	}

	.endpoint--link:hover {
		border-color: var(--primary);
	}

	.endpoint__symbol {
		display: grid;
		flex-shrink: 0;
		place-items: center;
		width: 30px;
		height: 30px;
		border: 1px solid var(--border-subtle);
		border-radius: min(6px, var(--radius-control));
		background: var(--bg-subtle);
		color: var(--text-secondary);
		font-size: var(--fs-overline);
		font-weight: var(--fw-bold);
		--icon-size: var(--icon-md);
	}

	.endpoint--authrim .endpoint__symbol {
		background: var(--bg-hover);
	}

	.endpoint__text {
		display: grid;
		min-width: 0;
		gap: 3px;
	}

	.endpoint__text strong {
		font-size: var(--fs-caption);
		font-weight: var(--fw-name);
		overflow-wrap: anywhere;
	}

	.endpoint__text small {
		color: var(--text-muted);
		font-size: var(--fs-overline);
		overflow-wrap: anywhere;
	}
</style>
