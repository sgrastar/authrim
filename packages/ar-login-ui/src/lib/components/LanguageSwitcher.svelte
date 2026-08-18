<script lang="ts">
	import { LL, getLocale, setLocale } from '$i18n/i18n-svelte';
	import type { Locales } from '$i18n/i18n-types';
	import { useLoginUIStores } from '$lib/stores/login-ui-context';
	import { buildDiagnosticHeaders } from '$lib/api/client';
	import { isLoginUILocale, toDocumentDirection, toDocumentLanguage } from '$lib/i18n/locales';
	import { buildLoginUILanguageSelectorModel } from '$lib/i18n/language-selector';

	const { languageStore, themeStore } = useLoginUIStores();

	let {
		showThemeToggle = true,
		showLanguageSelect = true
	}: { showThemeToggle?: boolean; showLanguageSelect?: boolean } = $props();

	let currentLang = $state<Locales>(getLocale());
	const selectorModel = $derived(
		buildLoginUILanguageSelectorModel(
			languageStore.supportedLocales,
			languageStore.primaryLocales,
			languageStore.showEnglishLanguageNames,
			currentLang
		)
	);

	$effect(() => {
		if (!languageStore.isEnabled(currentLang)) {
			currentLang = languageStore.defaultLocale;
			setLocale(currentLang);
			document.documentElement.lang = toDocumentLanguage(currentLang);
			document.documentElement.dir = toDocumentDirection(currentLang);
		}
	});

	async function switchLanguage(lang: string) {
		if (!isLoginUILocale(lang) || !languageStore.isEnabled(lang)) return;

		setLocale(lang);
		currentLang = lang;
		document.documentElement.lang = toDocumentLanguage(lang);
		document.documentElement.dir = toDocumentDirection(lang);
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
				{#if selectorModel.grouped}
					{#each selectorModel.mainOptions as option (option.locale)}
						<option value={option.locale}>{option.label}</option>
					{/each}
					<optgroup label={selectorModel.allLanguagesLabel}>
						{#each selectorModel.allLanguageOptions as option (option.locale)}
							<option value={option.locale}>{option.label}</option>
						{/each}
					</optgroup>
				{:else}
					{#each selectorModel.flatOptions as option (option.locale)}
						<option value={option.locale}>{option.label}</option>
					{/each}
				{/if}
			</select>
		</div>
	{/if}
</div>
