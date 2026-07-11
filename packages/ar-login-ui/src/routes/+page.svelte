<script lang="ts">
	import { onMount } from 'svelte';
	import LanguageSwitcher from '$lib/components/LanguageSwitcher.svelte';
	import { Button } from '$lib/components';
	import { LL } from '$i18n/i18n-svelte';
	import { fetchAuthenticationMethods } from '$lib/api/authentication-methods';
	import { auth, isAuthenticated } from '$lib/stores/auth';
	import { useLoginUIStores } from '$lib/stores/login-ui-context';

	const { brandingStore } = useLoginUIStores();

	let mounted = $state(false);
	let accountPageEnabled = $state(false);
	let accountPagePath = $state('/account');

	onMount(async () => {
		auth.refresh();

		const [methodsResult] = await Promise.all([
			fetchAuthenticationMethods(),
			auth.refreshFromSession()
		]);
		const selfService = methodsResult.data?.ui.selfService;
		const configuredAccountPath = selfService?.accountPagePath;
		accountPageEnabled = selfService?.accountPageEnabled === true;
		if (accountPageEnabled && configuredAccountPath?.startsWith('/')) {
			accountPagePath = configuredAccountPath;
		}

		// Stagger entrance animation
		requestAnimationFrame(() => {
			mounted = true;
		});
	});
</script>

<svelte:head>
	<title>{brandingStore.brandName || $LL.app_title()} - {$LL.landing_providerBadge()}</title>
	<meta name="description" content={$LL.landing_metaDescription()} />
</svelte:head>

<div class="landing" class:landing--mounted={mounted}>
	<!-- Decorative grid pattern -->
	<div class="landing__grid-pattern" aria-hidden="true"></div>

	<!-- Header -->
	<header class="landing__header">
		<div class="landing__header-inner">
			<a href="/" class="landing__logo">
				<div class="landing__logo-mark" aria-hidden="true">
					<svg width="28" height="28" viewBox="0 0 28 28" fill="none">
						<rect x="2" y="2" width="10" height="10" rx="2" fill="currentColor" opacity="0.9" />
						<rect x="16" y="2" width="10" height="10" rx="2" fill="currentColor" opacity="0.5" />
						<rect x="2" y="16" width="10" height="10" rx="2" fill="currentColor" opacity="0.5" />
						<rect x="16" y="16" width="10" height="10" rx="2" fill="currentColor" opacity="0.25" />
					</svg>
				</div>
				<span class="home-header__brand landing__logo-text">
					{brandingStore.brandName || $LL.app_title()}
				</span>
			</a>

			<div class="landing__header-actions">
				<LanguageSwitcher />

				{#if $isAuthenticated}
					{#if accountPageEnabled}
						<a href={accountPagePath}>
							<Button variant="secondary">{$LL.account_openPage()}</Button>
						</a>
					{/if}
				{:else}
					<div class="landing__auth-buttons">
						<a href="/signup" data-sveltekit-reload>
							<Button variant="ghost">
								{$LL.header_signUp()}
							</Button>
						</a>
						<a href="/discover" data-sveltekit-reload>
							<Button variant="primary">
								{$LL.header_login()}
							</Button>
						</a>
					</div>
				{/if}
			</div>
		</div>
	</header>

	<!-- Hero -->
	<main class="landing__main">
		<div class="landing__hero">
			<!-- Floating accent shapes -->
			<div class="landing__accent landing__accent--1" aria-hidden="true"></div>
			<div class="landing__accent landing__accent--2" aria-hidden="true"></div>

			<div class="landing__hero-content">
				<div class="landing__badge">
					<span class="landing__badge-dot"></span>
					{$LL.landing_providerBadge()}
				</div>

				<h1 class="home-header__brand landing__title">
					{brandingStore.brandName || $LL.app_title()}
				</h1>

				{#if $isAuthenticated}
					<!-- Authenticated state -->
					{#if accountPageEnabled}
						<div class="landing__cta">
							<a href={accountPagePath} class="landing__cta-primary">
								<span>{$LL.account_openPage()}</span>
								<div class="i-heroicons-arrow-right h-4 w-4"></div>
							</a>
						</div>
					{/if}
				{:else}
					<!-- Unauthenticated state -->
					<div class="landing__cta">
						<a href="/discover" class="landing__cta-primary" data-sveltekit-reload>
							<span>{$LL.header_login()}</span>
							<div class="i-heroicons-arrow-right h-4 w-4"></div>
						</a>
						<a href="/signup" class="landing__cta-secondary" data-sveltekit-reload>
							{$LL.header_signUp()}
						</a>
					</div>
				{/if}
			</div>
		</div>
	</main>

	<!-- Footer -->
	<footer class="landing__footer">
		<p>{$LL.footer_stack()}</p>
	</footer>
</div>

<style>
	/* === Landing Page Layout === */
	.landing {
		min-height: 100vh;
		display: flex;
		flex-direction: column;
		background: var(--bg-page);
		position: relative;
		overflow: hidden;
	}

	/* === Decorative Grid Pattern === */
	.landing__grid-pattern {
		position: fixed;
		inset: 0;
		background-image:
			linear-gradient(var(--border) 1px, transparent 1px),
			linear-gradient(90deg, var(--border) 1px, transparent 1px);
		background-size: 80px 80px;
		opacity: 0.3;
		pointer-events: none;
		z-index: 0;
		mask-image: radial-gradient(ellipse 70% 50% at 50% 40%, black 10%, transparent 70%);
		-webkit-mask-image: radial-gradient(ellipse 70% 50% at 50% 40%, black 10%, transparent 70%);
	}

	/* === Header === */
	.landing__header {
		position: sticky;
		top: 0;
		z-index: 50;
		background: var(--bg-card);
		border-bottom: 1px solid var(--border);
		backdrop-filter: blur(12px);
		-webkit-backdrop-filter: blur(12px);
	}

	.landing__header-inner {
		max-width: 1200px;
		margin: 0 auto;
		padding: 0 24px;
		display: flex;
		align-items: center;
		justify-content: space-between;
		height: 64px;
		gap: 12px;
	}

	/* === Logo === */
	.landing__logo {
		display: flex;
		align-items: center;
		gap: 10px;
		text-decoration: none;
		flex-shrink: 0;
	}

	.landing__logo-mark {
		color: var(--primary);
		display: flex;
		align-items: center;
	}

	.landing__logo-text {
		font-family: var(--font-display);
		font-size: 1.125rem;
		font-weight: 700;
		color: var(--text-primary);
		letter-spacing: -0.02em;
	}

	/* === Header Actions === */
	.landing__header-actions {
		display: flex;
		align-items: center;
		gap: 8px;
		min-width: 0;
	}

	/* Override auth-topbar absolute positioning inside landing header */
	.landing__header-actions :global(.auth-topbar) {
		position: static;
		top: auto;
		right: auto;
		z-index: auto;
	}

	.landing__auth-buttons {
		display: flex;
		align-items: center;
		gap: 6px;
	}

	/* === Main / Hero === */
	.landing__main {
		flex: 1;
		display: flex;
		align-items: center;
		justify-content: center;
		padding: 40px 24px;
		position: relative;
		z-index: 1;
	}

	.landing__hero {
		width: 100%;
		max-width: 720px;
		position: relative;
	}

	/* === Accent Shapes === */
	.landing__accent {
		position: absolute;
		border-radius: 50%;
		pointer-events: none;
		filter: blur(60px);
	}

	.landing__accent--1 {
		width: 300px;
		height: 300px;
		top: -80px;
		right: -100px;
		background: var(--primary-light);
		opacity: 0.6;
	}

	.landing__accent--2 {
		width: 200px;
		height: 200px;
		bottom: -40px;
		left: -60px;
		background: var(--accent-light);
		opacity: 0.5;
	}

	/* === Hero Content === */
	.landing__hero-content {
		text-align: center;
		position: relative;
		z-index: 1;
	}

	/* === Badge === */
	.landing__badge {
		display: inline-flex;
		align-items: center;
		gap: 8px;
		padding: 6px 14px;
		border-radius: var(--radius-full);
		background: var(--bg-card);
		border: 1px solid var(--border);
		font-size: 0.75rem;
		font-weight: 600;
		color: var(--text-secondary);
		letter-spacing: 0.04em;
		text-transform: uppercase;
		margin-bottom: 24px;
		opacity: 0;
		transform: translateY(12px);
		transition: all 0.6s cubic-bezier(0.16, 1, 0.3, 1);
	}

	.landing--mounted .landing__badge {
		opacity: 1;
		transform: translateY(0);
	}

	.landing__badge-dot {
		width: 6px;
		height: 6px;
		border-radius: 50%;
		background: var(--success);
		box-shadow: 0 0 8px var(--success);
		animation: pulse-dot 2s ease-in-out infinite;
	}

	@keyframes pulse-dot {
		0%,
		100% {
			opacity: 1;
		}
		50% {
			opacity: 0.4;
		}
	}

	/* === Title === */
	.landing__title {
		font-family: var(--font-display);
		font-size: clamp(2.5rem, 6vw, 4rem);
		font-weight: 800;
		color: var(--text-primary);
		letter-spacing: -0.04em;
		line-height: 1.05;
		margin: 0 0 16px 0;
		transform: translateY(16px);
		transition:
			transform 0.7s cubic-bezier(0.16, 1, 0.3, 1) 0.1s,
			opacity 0.7s cubic-bezier(0.16, 1, 0.3, 1) 0.1s;
	}

	.landing--mounted .landing__title {
		transform: translateY(0);
	}

	/*
	 * Brand flash prevention via home-header__brand (global app.css):
	 * opacity: 0 by default, opacity: 1 when [data-branding-loaded] is set.
	 * The mounted animation also needs opacity control, so we rely on
	 * the global home-header__brand for opacity and only animate transform here.
	 * When mounted + branding loaded, both conditions are met → visible.
	 */

	/* === CTA Buttons (Unauthenticated) === */
	.landing__cta {
		display: flex;
		align-items: center;
		justify-content: center;
		gap: 12px;
		opacity: 0;
		transform: translateY(16px);
		transition: all 0.7s cubic-bezier(0.16, 1, 0.3, 1) 0.3s;
	}

	.landing--mounted .landing__cta {
		opacity: 1;
		transform: translateY(0);
	}

	.landing__cta-primary {
		display: inline-flex;
		align-items: center;
		gap: 8px;
		padding: 12px 28px;
		border-radius: var(--radius-md);
		background: var(--gradient-primary);
		color: var(--text-inverse);
		font-weight: 600;
		font-size: 0.9375rem;
		text-decoration: none;
		transition: all var(--transition-fast);
		box-shadow:
			var(--shadow-md),
			0 0 0 0 var(--primary-glow);
	}

	.landing__cta-primary:hover {
		transform: translateY(-1px);
		box-shadow:
			var(--shadow-lg),
			0 0 24px var(--primary-glow);
		color: var(--text-inverse);
	}

	.landing__cta-secondary {
		display: inline-flex;
		align-items: center;
		padding: 12px 24px;
		border-radius: var(--radius-md);
		color: var(--text-secondary);
		font-weight: 600;
		font-size: 0.9375rem;
		text-decoration: none;
		transition: all var(--transition-fast);
		border: 1px solid var(--border);
		background: var(--bg-card);
	}

	.landing__cta-secondary:hover {
		color: var(--text-primary);
		border-color: var(--primary);
		background: var(--primary-light);
	}

	/* === Footer === */
	.landing__footer {
		position: relative;
		z-index: 1;
		text-align: center;
		padding: 24px;
		font-size: 0.75rem;
		color: var(--text-muted);
	}

	.landing__footer p {
		margin: 0;
	}

	/* === Responsive === */
	@media (max-width: 640px) {
		.landing__header-inner {
			padding: 0 16px;
		}

		.landing__logo-mark {
			display: none;
		}

		.landing__main {
			padding: 24px 16px;
		}

		.landing__badge {
			font-size: 0.6875rem;
			padding: 5px 12px;
		}

		.landing__cta {
			flex-direction: column;
			width: 100%;
			max-width: 320px;
			margin: 0 auto;
		}

		.landing__cta-primary,
		.landing__cta-secondary {
			width: 100%;
			justify-content: center;
		}

		.landing__grid-pattern {
			background-size: 40px 40px;
		}
	}

	@media (max-width: 400px) {
		.landing__auth-buttons {
			gap: 4px;
		}
	}

	@media (min-width: 1024px) {
		.landing__hero-content {
			padding: 20px 0;
		}
	}

	/* === Reduced Motion === */
	@media (prefers-reduced-motion: reduce) {
		.landing__badge,
		.landing__title,
		.landing__cta {
			opacity: 1;
			transform: none;
			transition: none;
		}

		.landing__badge-dot {
			animation: none;
		}
	}
</style>
