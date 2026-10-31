<script lang="ts">
	import { flip } from 'svelte/animate';
	import { fly } from 'svelte/transition';
	import { t } from '$lib/i18n/i18n.svelte';
	import Icon from '../icons/Icon.svelte';
	import type { IconName } from '../icons/icons';
	import IconButton from '../primitives/IconButton.svelte';
	import { toast, type ToastTone } from './toast.svelte';

	/**
	 * Renders notifications at the bottom end of the viewport. Mounted once in the root layout.
	 * Errors use role="alert" (announced immediately); the rest use role="status".
	 */
	const ICON: Record<ToastTone, IconName> = {
		success: 'checkCircle',
		error: 'warningCircle',
		warning: 'warning',
		info: 'info'
	};

	const reduce =
		typeof window !== 'undefined' &&
		window.matchMedia?.('(prefers-reduced-motion: reduce)').matches === true;
</script>

<section
	class="toaster"
	aria-label={t('toast.region')}
	onpointerenter={() => toast.pause()}
	onpointerleave={() => toast.resume()}
	onfocusin={() => toast.pause()}
	onfocusout={() => toast.resume()}
>
	{#each toast.items as item (item.id)}
		<div
			class="toast toast--{item.tone}"
			role={item.tone === 'error' ? 'alert' : 'status'}
			animate:flip={{ duration: reduce ? 0 : 200 }}
			transition:fly={{ y: reduce ? 0 : 16, duration: reduce ? 0 : 180 }}
		>
			<span class="toast__icon"><Icon name={ICON[item.tone]} /></span>
			<div class="toast__text">
				<p class="toast__title">{item.title ?? t(`toast.${item.tone}`)}</p>
				<p class="toast__message">{item.message}</p>
			</div>
			<span class="toast__close">
				<IconButton icon="close" label={t('app.close')} onclick={() => toast.dismiss(item.id)} />
			</span>
			{#if item.duration > 0}
				<span
					class="toast__timer"
					class:is-paused={toast.paused}
					style:animation-duration="{item.duration}ms"
				></span>
			{/if}
		</div>
	{/each}
</section>

<style>
	.toaster {
		position: fixed;
		inset-block-end: 16px;
		inset-inline-end: 16px;
		z-index: var(--z-toast);
		display: grid;
		justify-items: end;
		gap: 8px;
		width: min(24rem, calc(100vw - 32px));
		pointer-events: none;
	}

	.toast {
		--toast-accent: var(--info);
		position: relative;
		display: flex;
		align-items: flex-start;
		gap: 10px;
		width: 100%;
		padding-block: 12px 14px;
		padding-inline: 14px 8px;
		overflow: hidden;
		border: 1px solid var(--border);
		border-radius: var(--radius-panel);
		background: var(--bg-card);
		box-shadow: var(--shadow-lg);
		pointer-events: auto;
	}

	.toast--success {
		--toast-accent: var(--success);
	}

	.toast--error {
		--toast-accent: var(--danger);
	}

	.toast--warning {
		--toast-accent: var(--warning);
	}

	.toast__icon {
		display: inline-flex;
		margin-top: 1px;
		color: var(--toast-accent);
		--icon-size: var(--icon-lg);
	}

	.toast__text {
		min-width: 0;
		flex: 1;
	}

	.toast__title {
		margin: 0;
		font-size: var(--fs-body);
		font-weight: var(--fw-semibold);
	}

	.toast__message {
		margin: 2px 0 0;
		font-size: var(--fs-label);
		color: var(--text-secondary);
		overflow-wrap: anywhere;
	}

	.toast__close {
		margin-top: -4px;
	}

	/* Remaining time. The animation runs for the full duration and pauses with the timers, so
	   it stays in step without being restarted. */
	.toast__timer {
		position: absolute;
		inset-block-end: 0;
		inset-inline-start: 0;
		width: 100%;
		height: 2px;
		background: var(--toast-accent);
		opacity: 0.6;
		transform-origin: var(--timer-origin, left);
		animation: toast-timer linear forwards;
	}

	:global([dir='rtl']) .toast__timer {
		--timer-origin: right;
	}

	.toast__timer.is-paused {
		animation-play-state: paused;
	}

	@keyframes toast-timer {
		to {
			transform: scaleX(0);
		}
	}

	@media (prefers-reduced-motion: reduce) {
		.toast__timer {
			display: none;
		}
	}
</style>
