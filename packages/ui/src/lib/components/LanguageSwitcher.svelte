<script lang="ts">
	import { languageTag, setLanguageTag, availableLanguageTags } from '$lib/paraglide/runtime.js';
	import * as m from '$lib/paraglide/messages.js';
	import { Globe } from 'lucide-svelte';

	let currentLang = $state(languageTag());

	function switchLanguage(lang: string) {
		setLanguageTag(lang);
		currentLang = lang;
		// Force re-render by reloading (for demo purposes)
		if (typeof window !== 'undefined') {
			window.location.reload();
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
