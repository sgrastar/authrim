<script lang="ts">
	import { LL, getLocale, setLocale } from '$i18n/i18n-svelte';
	import { SUPPORTED_LOCALES } from '$i18n/locales';
	import type { Locales } from '$i18n/i18n-types';

	let currentLang = $state<Locales>(getLocale());
	let errorMessage = $state('');

	function languageLabel(lang: Locales): string {
		return lang === 'en' ? $LL.language_english() : $LL.language_japanese();
	}

	async function switchLanguage(lang: Locales) {
		errorMessage = '';

		// Save to server-side cookie via API (not affected by Safari ITP 7-day limit)
		try {
			const response = await fetch('/api/set-language', {
				method: 'POST',
				headers: {
					'Content-Type': 'application/json'
				},
				body: JSON.stringify({ language: lang })
			});

			if (!response.ok) {
				throw new Error('Failed to update language');
			}

			// Update client-side language tag
			setLocale(lang);
			currentLang = lang;

			// Reload page to apply language change across all components
			if (typeof window !== 'undefined') {
				window.location.reload();
			}
		} catch {
			errorMessage = $LL.language_switch_error();
		}
	}
</script>

<div class="language-switcher">
	<div class="i-heroicons-globe-alt language-icon"></div>
	<select
		value={currentLang}
		onchange={(e) => switchLanguage(e.currentTarget.value as Locales)}
		aria-label={$LL.language_select_label()}
		aria-invalid={errorMessage ? 'true' : undefined}
		class="language-select"
	>
		{#each SUPPORTED_LOCALES as lang (lang)}
			<option value={lang}>
				{languageLabel(lang)}
			</option>
		{/each}
	</select>
	{#if errorMessage}
		<span class="sr-only" role="alert">{errorMessage}</span>
	{/if}
</div>

<style>
	.language-switcher {
		display: inline-flex;
		align-items: center;
		gap: 8px;
	}

	.language-icon {
		width: 16px;
		height: 16px;
		font-size: 16px;
		color: var(--color-text-muted);
	}

	.language-select {
		min-height: 32px;
		padding: 4px 8px;
		border: var(--control-border, 1px solid var(--color-border));
		border-radius: var(--radius-control, 6px);
		background: var(--control-bg, var(--color-surface));
		color: var(--color-text);
		box-shadow: var(--control-shadow, none);
		font: inherit;
		font-size: 14px;
	}

	.language-select:focus {
		outline: none;
		border-color: var(--control-focus-border, var(--color-accent));
		box-shadow: var(--control-focus-shadow, 0 0 0 3px var(--color-accent-muted));
	}
</style>
