<script lang="ts">
	/**
	 * The public statement page: a consent statement's text, read from ar-auth's public statement
	 * API in the reader's language (`?version=YYYYMMDD` for an earlier published version).
	 */
	import { page } from '$app/state';
	import { LL, getLocale } from '$i18n/i18n-svelte';
	import StatementPageView from '#lib/views/StatementPageView.svelte';
	import {
		fetchStatementPage,
		requestedStatementVersion,
		type StatementPageResult
	} from '#lib/api/statement-page.js';

	let result = $state<StatementPageResult | null>(null);
	let generation = 0;

	$effect(() => {
		const slug = page.params.slug ?? '';
		const version = requestedStatementVersion(page.url.searchParams.get('version'));
		// Read again in the new language when the reader switches it ($LL follows the locale).
		void $LL;
		const lang = getLocale();
		const current = ++generation;
		result = null;
		void fetchStatementPage(slug, version, lang).then((answer) => {
			if (current === generation) result = answer;
		});
	});
</script>

<StatementPageView {result} />
