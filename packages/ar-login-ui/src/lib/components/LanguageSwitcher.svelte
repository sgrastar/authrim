<script lang="ts">
	import { LL, getLocale, setLocale } from '$i18n/i18n-svelte';
	import type { Locales } from '$i18n/i18n-types';
	import { themeStore } from '$lib/stores/theme.svelte';
	import { buildDiagnosticHeaders } from '$lib/api/client';

	const availableLocales: Locales[] = ['en', 'ja'];
	let currentLang = $state<Locales>(getLocale());

	async function switchLanguage(lang: string) {
		// Save to server-side cookie via API (not affected by Safari ITP 7-day limit)
		try {
			await fetch('/api/set-language', {
				method: 'POST',
				headers: buildDiagnosticHeaders({
					'Content-Type': 'application/json'
				}),
				body: JSON.stringify({ language: lang })
			});

			// Update client-side language tag
			setLocale(lang as Locales);
			currentLang = lang as Locales;

			// Update html lang attribute
			document.documentElement.lang = lang;

			// Reload page to apply language change across all components
			if (typeof window !== 'undefined') {
				window.location.reload();
			}
		} catch (error) {
			console.error('Failed to set language:', error);
		}
	}
</script>

<div class="auth-topbar">
	<!-- Theme Toggle -->
	<button
		type="button"
		class="theme-toggle"
		onclick={() => themeStore.toggleMode()}
		aria-label={themeStore.isDark ? 'Switch to light mode' : 'Switch to dark mode'}
	>
		{#if themeStore.isDark}
			<div class="i-heroicons-sun h-4.5 w-4.5"></div>
		{:else}
			<div class="i-heroicons-moon h-4.5 w-4.5"></div>
		{/if}
	</button>

	<!-- Language Selector -->
	<div class="flex items-center gap-1.5">
		<select
			value={currentLang}
			onchange={(e) => switchLanguage(e.currentTarget.value)}
			aria-label="Language"
			class="auth-lang-select"
		>
			{#each availableLocales as lang (lang)}
				<option value={lang}>
					{lang === 'en' ? $LL.language_english() : $LL.language_japanese()}
				</option>
			{/each}
		</select>
	</div>
</div>
