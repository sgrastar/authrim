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

<div class="flex items-center gap-2">
	<div class="i-heroicons-globe-alt h-4 w-4 text-gray-500"></div>
	<select
		value={currentLang}
		onchange={(e) => switchLanguage(e.currentTarget.value as Locales)}
		aria-label={$LL.language_select_label()}
		aria-invalid={errorMessage ? 'true' : undefined}
		class="px-2 py-1 text-sm border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-primary-500 bg-white dark:bg-gray-700 text-gray-900 dark:text-white"
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
