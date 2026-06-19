<script lang="ts">
	import { onDestroy, onMount } from 'svelte';

	type HumanVerificationProvider = 'turnstile' | 'hcaptcha' | 'recaptcha' | 'custom';
	type HumanVerificationMode = 'managed' | 'checkbox' | 'invisible' | 'score';
	type CaptchaTheme = 'auto' | 'light' | 'dark';

	let {
		provider = 'turnstile',
		siteKey,
		action,
		mode = 'managed',
		theme = 'auto',
		language = 'auto',
		token = $bindable(''),
		disabled = false,
		loadingLabel = 'Loading security check...',
		errorLabel = 'Security check could not be loaded. Reload the page and try again.'
	}: {
		provider?: HumanVerificationProvider;
		siteKey: string;
		action: string;
		mode?: HumanVerificationMode;
		theme?: CaptchaTheme;
		language?: string;
		token?: string;
		disabled?: boolean;
		loadingLabel?: string;
		errorLabel?: string;
	} = $props();

	let container: HTMLDivElement;
	let widgetId: string | null = null;
	let renderedKey = '';
	let scriptLoaded = $state(false);
	let failed = $state(false);
	let widgetRendered = $state(false);

	function providerScriptSelector(): string {
		if (provider === 'hcaptcha') {
			return 'script[data-authrim-hcaptcha], script[src*="js.hcaptcha.com/1/api.js"]';
		}
		if (provider === 'recaptcha') {
			return 'script[data-authrim-recaptcha], script[src*="google.com/recaptcha/api.js"]';
		}
		return 'script[data-authrim-turnstile], script[src*="challenges.cloudflare.com/turnstile/v0/api.js"]';
	}

	function normalizeLanguageParam(): string {
		return language && language !== 'auto' ? `&hl=${encodeURIComponent(language)}` : '';
	}

	function scriptSrc(): string {
		const lang = normalizeLanguageParam();
		if (provider === 'hcaptcha') {
			return `https://js.hcaptcha.com/1/api.js?render=explicit${lang}`;
		}
		if (provider === 'recaptcha') {
			const render = mode === 'score' ? encodeURIComponent(siteKey) : 'explicit';
			return `https://www.google.com/recaptcha/api.js?render=${render}${lang}`;
		}
		return 'https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit';
	}

	function markScript(script: HTMLScriptElement) {
		if (provider === 'hcaptcha') script.dataset.authrimHcaptcha = 'true';
		else if (provider === 'recaptcha') script.dataset.authrimRecaptcha = 'true';
		else script.dataset.authrimTurnstile = 'true';
	}

	function makeScriptReadyCompatible(script: HTMLScriptElement) {
		if (provider !== 'turnstile') return;
		script.async = false;
		script.defer = false;
		script.removeAttribute('async');
		script.removeAttribute('defer');
	}

	function providerReady(): boolean {
		if (provider === 'hcaptcha') return Boolean(window.hcaptcha);
		if (provider === 'recaptcha') return Boolean(window.grecaptcha);
		return Boolean(window.turnstile);
	}

	function loadScript(): Promise<void> {
		const existing = document.querySelector<HTMLScriptElement>(providerScriptSelector());
		if (existing) makeScriptReadyCompatible(existing);
		if (providerReady()) return Promise.resolve();
		if (existing) {
			return new Promise((resolve, reject) => {
				existing.addEventListener('load', () => resolve(), { once: true });
				existing.addEventListener('error', () => reject(new Error('captcha_script_failed')), {
					once: true
				});
			});
		}

		return new Promise((resolve, reject) => {
			const script = document.createElement('script');
			script.src = scriptSrc();
			makeScriptReadyCompatible(script);
			markScript(script);
			script.onload = () => resolve();
			script.onerror = () => reject(new Error('captcha_script_failed'));
			document.head.appendChild(script);
		});
	}

	function currentRenderKey(): string {
		return [provider, siteKey, action, mode, theme, language].join(':');
	}

	function providerAction(): string {
		if (provider === 'recaptcha' && mode === 'score') {
			return action.replaceAll('-', '_');
		}
		return action;
	}

	function effectiveTheme(): 'light' | 'dark' | undefined {
		return theme === 'light' || theme === 'dark' ? theme : undefined;
	}

	function clearRenderedWidget() {
		token = '';
		if (provider === 'turnstile' && widgetId && window.turnstile) {
			window.turnstile.remove(widgetId);
		}
		if (provider === 'hcaptcha' && widgetId && window.hcaptcha) {
			window.hcaptcha.remove(widgetId);
		}
		if (provider === 'recaptcha' && widgetId && window.grecaptcha) {
			window.grecaptcha.reset(widgetId);
		}
		widgetId = null;
		widgetRendered = false;
		renderedKey = '';
	}

	function renderTurnstile(renderKey: string) {
		if (!container || !window.turnstile) return;
		window.turnstile.ready(() => {
			if (!container || widgetId || disabled) return;
			try {
				widgetId = window.turnstile!.render(container, {
					sitekey: siteKey,
					action,
					theme,
					language,
					size: 'flexible',
					execution: 'render',
					appearance: 'always',
					callback: (value: string) => {
						token = value;
						failed = false;
					},
					'expired-callback': () => {
						token = '';
					},
					'error-callback': () => {
						token = '';
						failed = true;
					}
				});
				widgetRendered = Boolean(widgetId);
				renderedKey = renderKey;
			} catch {
				token = '';
				failed = true;
			}
		});
	}

	function renderHCaptcha(renderKey: string) {
		if (!container || !window.hcaptcha) return;
		try {
			widgetId = window.hcaptcha.render(container, {
				sitekey: siteKey,
				theme: effectiveTheme(),
				size: mode === 'invisible' ? 'invisible' : 'normal',
				callback: (value: string) => {
					token = value;
					failed = false;
				},
				'expired-callback': () => {
					token = '';
				},
				'error-callback': () => {
					token = '';
					failed = true;
				}
			});
			widgetRendered = Boolean(widgetId) || mode === 'invisible';
			renderedKey = renderKey;
			if (mode === 'invisible' && widgetId) {
				window.hcaptcha.execute(widgetId);
			}
		} catch {
			token = '';
			failed = true;
		}
	}

	function renderReCaptcha(renderKey: string) {
		if (!container || !window.grecaptcha) return;
		window.grecaptcha.ready(() => {
			if (disabled || renderedKey === renderKey) return;
			try {
				if (mode === 'score') {
					const result = window.grecaptcha!.execute(siteKey, { action: providerAction() });
					if (result && typeof (result as Promise<string>).then === 'function') {
						(result as Promise<string>)
							.then((value) => {
								token = value;
								failed = false;
								widgetRendered = true;
								renderedKey = renderKey;
							})
							.catch(() => {
								token = '';
								failed = true;
							});
					}
					return;
				}

				widgetId = window.grecaptcha!.render(container, {
					sitekey: siteKey,
					theme: effectiveTheme(),
					size: mode === 'invisible' ? 'invisible' : 'normal',
					callback: (value: string) => {
						token = value;
						failed = false;
					},
					'expired-callback': () => {
						token = '';
					},
					'error-callback': () => {
						token = '';
						failed = true;
					}
				});
				widgetRendered = Boolean(widgetId) || mode === 'invisible';
				renderedKey = renderKey;
				if (mode === 'invisible' && widgetId) {
					window.grecaptcha!.execute(widgetId);
				}
			} catch {
				token = '';
				failed = true;
			}
		});
	}

	function renderWidget() {
		if (!container || disabled) return;
		if (provider === 'custom') {
			failed = true;
			return;
		}
		const renderKey = currentRenderKey();
		if (widgetId && renderedKey === renderKey) return;
		if (renderedKey && renderedKey !== renderKey) clearRenderedWidget();

		if (provider === 'hcaptcha') renderHCaptcha(renderKey);
		else if (provider === 'recaptcha') renderReCaptcha(renderKey);
		else renderTurnstile(renderKey);
	}

	export function reset() {
		token = '';
		if (provider === 'turnstile' && widgetId && window.turnstile) window.turnstile.reset(widgetId);
		if (provider === 'hcaptcha' && widgetId && window.hcaptcha) window.hcaptcha.reset(widgetId);
		if (provider === 'recaptcha' && window.grecaptcha)
			window.grecaptcha.reset(widgetId ?? undefined);
	}

	onMount(async () => {
		try {
			await loadScript();
			scriptLoaded = true;
			renderWidget();
		} catch {
			failed = true;
		}
	});

	$effect(() => {
		if (scriptLoaded) renderWidget();
	});

	onDestroy(() => {
		clearRenderedWidget();
	});
</script>

<div class="turnstile-wrap" class:disabled class:failed>
	{#if failed}
		<p class="turnstile-status error">{errorLabel}</p>
	{:else if !widgetRendered}
		<p class="turnstile-status">{loadingLabel}</p>
	{/if}
	<div bind:this={container}></div>
</div>

<style>
	.turnstile-wrap {
		display: flex;
		flex-direction: column;
		align-items: center;
		justify-content: center;
		gap: 8px;
		min-height: 70px;
		margin: 12px 0;
	}

	.turnstile-wrap.disabled {
		opacity: 0.65;
		pointer-events: none;
	}

	.turnstile-wrap.failed {
		min-height: auto;
	}

	.turnstile-status {
		margin: 0;
		color: var(--text-secondary);
		font-size: 0.875rem;
		line-height: 1.4;
		text-align: center;
	}

	.turnstile-status.error {
		color: var(--error);
	}
</style>
