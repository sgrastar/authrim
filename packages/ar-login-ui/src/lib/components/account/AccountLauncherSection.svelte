<script lang="ts">
	/** Loads the account's launchers and saves favourites for the launcher widget. */
	import { onMount } from 'svelte';
	import { LL } from '$i18n/i18n-svelte';
	import { accountAPI, type AccountLauncher } from '$lib/api/account';
	import AccountLauncherWidget from './widgets/AccountLauncherWidget.svelte';
	import type { AccountWidgetHeadingLevel } from './widgets/types';

	let {
		title = '',
		headingLevel = 2
	}: { title?: string; headingLevel?: AccountWidgetHeadingLevel } = $props();

	let launchers = $state<AccountLauncher[]>([]);
	let loading = $state(true);
	let error = $state('');
	let favoriteError = $state('');
	let favoriteLoading = $state<string[]>([]);

	async function loadLaunchers() {
		loading = true;
		error = '';
		favoriteError = '';
		const result = await accountAPI.getLaunchers();
		if (result.error) {
			error = $LL.account_launcherLoadFailed();
		} else {
			launchers = result.data?.launchers ?? [];
		}
		loading = false;
	}

	async function toggleFavorite(launcher: AccountLauncher) {
		if (favoriteLoading.includes(launcher.id)) return;
		favoriteError = '';
		favoriteLoading = [...favoriteLoading, launcher.id];
		const nextFavorite = !launcher.favorite;
		const result = await accountAPI.setLauncherFavorite(launcher.id, nextFavorite);
		if (!result.error) {
			launchers = launchers.map((entry) =>
				entry.id === launcher.id ? { ...entry, favorite: nextFavorite } : entry
			);
		} else {
			favoriteError = $LL.account_launcherFavoriteUpdateFailed();
		}
		favoriteLoading = favoriteLoading.filter((id) => id !== launcher.id);
	}

	onMount(() => void loadLaunchers());
</script>

<AccountLauncherWidget
	{launchers}
	{loading}
	{error}
	{favoriteError}
	{favoriteLoading}
	{title}
	{headingLevel}
	onRetry={loadLaunchers}
	onToggleFavorite={toggleFavorite}
/>
