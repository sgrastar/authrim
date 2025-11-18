<script lang="ts">
	import { languageTag, setLanguageTag, availableLanguageTags } from '$lib/paraglide/runtime.js';
	import * as m from '$lib/paraglide/messages.js';
	import { Globe } from 'lucide-svelte';

	let currentLang = $state(languageTag());

	async function switchLanguage(lang: string) {
		// Save to server-side cookie via API (not affected by Safari ITP 7-day limit)
		try {
			await fetch('/api/set-language', {
				method: 'POST',
				headers: {
					'Content-Type': 'application/json'
				},
				body: JSON.stringify({ language: lang })
			});

			// Update client-side language tag
			setLanguageTag(lang as 'en' | 'ja');
			currentLang = lang;

			// Reload page to apply language change across all components
			if (typeof window !== 'undefined') {
				window.location.reload();
			}
		} catch (error) {
			console.error('Failed to set language:', error);
		}
	}
</script>

<div class="flex items-center gap-2">
	<Globe class="h-4 w-4 text-gray-500" />
	<select
		value={currentLang}
		onchange={(e) => switchLanguage(e.currentTarget.value)}
		class="px-2 py-1 text-sm border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-primary-500 bg-white dark:bg-gray-700 text-gray-900 dark:text-white"
	>
		{#each availableLanguageTags as lang (lang)}
			<option value={lang}>
				{lang === 'en' ? m.language_english() : m.language_japanese()}
			</option>
		{/each}
	</select>
</div>
