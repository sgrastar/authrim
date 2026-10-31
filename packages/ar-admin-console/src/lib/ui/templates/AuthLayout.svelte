<script lang="ts">
	import type { Snippet } from 'svelte';
	import { t } from '$lib/i18n/i18n.svelte';
	import { provideBusy } from '../busy/busy';
	import Icon from '../icons/Icon.svelte';

	/**
	 * Entry pages outside the console (sign in, join, first-time setup): one centred card with
	 * the brand above and display/language controls below.
	 */
	interface Props {
		title: string;
		subtitle?: string;
		/** Preferences row under the card (language, display). */
		footer?: Snippet;
		/**
		 * An action is running (signing in, registering): every control on the page, the
		 * preferences row included, stops taking input until it finishes.
		 */
		busy?: boolean;
		children: Snippet;
	}

	let { title, subtitle, footer, busy = false, children }: Props = $props();

	provideBusy(() => busy);
</script>

<div class="auth">
	<main class="auth__main" data-reveal="on">
		<div class="auth__brand">
			<span class="auth__mark"><Icon name="sparkle" /></span>
			<span class="auth__name">{t('app.brand')}</span>
			<span class="auth__sub">{t('app.adminLabel')}</span>
		</div>
		<section class="auth__card" aria-busy={busy || undefined}>
			<h1>{title}</h1>
			{#if subtitle}<p class="auth__subtitle">{subtitle}</p>{/if}
			<div class="auth__body">{@render children()}</div>
		</section>
		{#if footer}<div class="auth__footer">{@render footer()}</div>{/if}
	</main>
</div>

<style>
	.auth {
		display: grid;
		min-height: 100vh;
		place-items: center;
		padding: 32px 16px;
	}

	.auth__main {
		display: grid;
		gap: 18px;
		width: min(400px, 100%);
	}

	.auth__brand {
		display: flex;
		align-items: center;
		justify-content: center;
		gap: 9px;
		font-weight: var(--fw-semibold);
	}

	.auth__mark {
		display: grid;
		place-items: center;
		width: 30px;
		height: 30px;
		border-radius: min(8px, var(--radius-control));
		background: var(--primary);
		color: var(--text-inverse);
		--icon-size: var(--icon-lg);
	}

	.auth__name {
		font-family: var(--font-brand);
		font-size: var(--fs-title);
	}

	.auth__sub {
		color: var(--text-muted);
		font-weight: var(--fw-medium);
	}

	.auth__card {
		padding: 28px 28px 24px;
		border: 1px solid var(--border);
		border-radius: var(--radius-panel);
		background: var(--surface-bg);
		-webkit-backdrop-filter: var(--surface-backdrop);
		backdrop-filter: var(--surface-backdrop);
		box-shadow: var(--shadow-md), var(--surface-highlight);
	}

	h1 {
		margin: 0;
		font-size: var(--fs-title-lg);
		font-weight: var(--heading-weight);
		letter-spacing: var(--heading-tracking);
	}

	.auth__subtitle {
		margin: 6px 0 0;
		color: var(--text-secondary);
		font-size: var(--fs-body);
	}

	.auth__body {
		display: grid;
		gap: 14px;
		margin-top: 20px;
	}

	.auth__footer {
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		justify-content: center;
		gap: 10px;
	}

	@media (max-width: 640px) {
		.auth__card {
			padding: 22px 18px 18px;
		}
	}
</style>
