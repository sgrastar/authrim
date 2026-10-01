<script lang="ts">
	import { t } from '$lib/i18n/i18n.svelte';
	import Icon from '../icons/Icon.svelte';

	/**
	 * Copies text to the clipboard and confirms it for two seconds. The confirmation is also
	 * announced (aria-live), since an icon change alone is invisible to screen readers.
	 */
	interface Props {
		/** Text to copy, or a function returning it at click time. */
		text: string | (() => string);
		/** What is being copied, for the accessible name ("Copy client ID"). */
		label?: string;
		/** Icon only, or icon with the "Copy" label. */
		variant?: 'icon' | 'button';
		size?: 'md' | 'sm';
	}

	let { text, label, variant = 'button', size = 'sm' }: Props = $props();

	let state = $state<'idle' | 'copied' | 'failed'>('idle');
	let timer: ReturnType<typeof setTimeout> | undefined;

	async function copy() {
		clearTimeout(timer);
		try {
			await navigator.clipboard.writeText(typeof text === 'function' ? text() : text);
			state = 'copied';
		} catch {
			state = 'failed';
		}
		timer = setTimeout(() => (state = 'idle'), 2000);
	}

	$effect(() => () => clearTimeout(timer));

	const name = $derived(label ?? t('copy.copy'));
	const message = $derived(
		state === 'copied' ? t('copy.copied') : state === 'failed' ? t('copy.failed') : ''
	);
</script>

<button
	type="button"
	class="copy copy--{variant} copy--{size}"
	class:is-copied={state === 'copied'}
	class:is-failed={state === 'failed'}
	aria-label={variant === 'icon' ? name : undefined}
	title={name}
	onclick={copy}
>
	<Icon name={state === 'copied' ? 'check' : state === 'failed' ? 'warningCircle' : 'copy'} />
	{#if variant === 'button'}
		<span>{state === 'idle' ? t('copy.copy') : message}</span>
	{/if}
</button>
<span class="sr-only" aria-live="polite">{message}</span>

<style>
	.copy {
		display: inline-flex;
		align-items: center;
		gap: 5px;
		height: var(--control-h-sm);
		padding: 0 10px;
		border: 1px solid var(--border);
		border-radius: var(--radius-control);
		background: var(--bg-card);
		color: var(--text-secondary);
		font-size: var(--fs-caption);
		font-weight: var(--fw-name);
		white-space: nowrap;
		--icon-size: var(--icon-sm);
	}

	.copy--sm {
		height: var(--control-h-xs);
		padding: 0 8px;
	}

	.copy--icon {
		justify-content: center;
		width: var(--control-h-sm);
		padding: 0;
	}

	.copy--icon.copy--sm {
		width: 26px;
	}

	.copy:hover {
		background: var(--bg-subtle);
		color: var(--text-primary);
	}

	.copy.is-copied {
		border-color: color-mix(in srgb, var(--success) 40%, var(--border));
		color: var(--success);
	}

	.copy.is-failed {
		border-color: color-mix(in srgb, var(--danger) 40%, var(--border));
		color: var(--danger);
	}
</style>
