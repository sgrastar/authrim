<script lang="ts">
	import { LL, getLocale, setLocale } from '$i18n/i18n-svelte';
	import type { Locales } from '$i18n/i18n-types';
	import { useLoginUIStores } from '$lib/stores/login-ui-context';
	import { buildDiagnosticHeaders } from '$lib/api/client';
	import {
		LOGIN_UI_LOCALES,
		LOGIN_UI_LOCALE_LABELS,
		isLoginUILocale,
		toDocumentLanguage
	} from '$lib/i18n/locales';

	const { themeStore } = useLoginUIStores();

	let {
		showThemeToggle = true,
		showLanguageSelect = true
	}: { showThemeToggle?: boolean; showLanguageSelect?: boolean } = $props();

	const availableLocales: Locales[] = [...LOGIN_UI_LOCALES];
	let currentLang = $state<Locales>(getLocale());

	async function switchLanguage(lang: string) {
		if (!isLoginUILocale(lang)) return;

		setLocale(lang);
		currentLang = lang;
		document.documentElement.lang = toDocumentLanguage(lang);
		window.dispatchEvent(new CustomEvent('authrim:locale-change', { detail: { locale: lang } }));

		try {
			await fetch('/api/set-language', {
				method: 'POST',
				headers: buildDiagnosticHeaders({
					'Content-Type': 'application/json'
				}),
				body: JSON.stringify({ language: lang })
			});
		} catch (error) {
			console.error('Failed to set language:', error);
		}
	}
</script>

<div class="auth-topbar">
	<!-- Theme Toggle -->
	{#if showThemeToggle}
		<button
			type="button"
			class="theme-toggle"
			onclick={() => themeStore.toggleMode()}
			aria-label={themeStore.isDark ? $LL.theme_switchToLightMode() : $LL.theme_switchToDarkMode()}
		>
			{#if themeStore.isDark}
				<div class="i-heroicons-sun h-4.5 w-4.5"></div>
			{:else}
				<div class="i-heroicons-moon h-4.5 w-4.5"></div>
			{/if}
		</button>
	{/if}

	<!-- Language Selector -->
	{#if showLanguageSelect}
		<div class="flex items-center gap-1.5">
			<select
				value={currentLang}
				onchange={(e) => switchLanguage(e.currentTarget.value)}
				aria-label={$LL.language_switch()}
				class="auth-lang-select"
			>
				{#each availableLocales as lang (lang)}
					<option value={lang}>{LOGIN_UI_LOCALE_LABELS[lang]}</option>
				{/each}
			</select>
		</div>
	{/if}
</div>
