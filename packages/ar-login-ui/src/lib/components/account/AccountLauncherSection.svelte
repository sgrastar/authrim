<script lang="ts">
	import { onMount } from 'svelte';
	import { getLocale, LL } from '$i18n/i18n-svelte';
	import { Card } from '$lib/components';
	import { accountAPI, type AccountLauncher } from '$lib/api/account';
	import { launcherMatchesSearch } from './account-launcher-filter';

	let { title = '' } = $props<{ title?: string }>();
	let launchers = $state<AccountLauncher[]>([]);
	let loading = $state(true);
	let error = $state('');
	let favoriteError = $state('');
	let query = $state('');
	let category = $state('');
	let favoritesOnly = $state(false);
	let favoriteLoading = $state<string[]>([]);

	const categories = $derived(
		[...new Set(launchers.map((launcher) => launcher.category).filter(Boolean) as string[])].sort(
			(left, right) => left.localeCompare(right, getLocale())
		)
	);
	const filteredLaunchers = $derived(
		launchers.filter((launcher) => {
			if (favoritesOnly && !launcher.favorite) return false;
			if (category && launcher.category !== category) return false;
			return launcherMatchesSearch(launcher, query, getLocale());
		})
	);

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

<Card>
	<section class="launcher-panel" aria-busy={loading}>
		<header class="launcher-panel__header">
			<div>
				<h2>{title || $LL.account_launcherTitle()}</h2>
				<p>{$LL.account_launcherDescription()}</p>
			</div>
			{#if launchers.length > 0}<span class="count">{launchers.length}</span>{/if}
		</header>

		{#if loading}
			<div class="launcher-grid" aria-label={$LL.common_loading()}>
				{#each Array(4) as _, index (index)}
					<div class="launcher-skeleton"><span></span><i></i><i></i></div>
				{/each}
			</div>
		{:else if error}
			<div class="state-message" role="alert">
				<p>{error}</p>
				<button type="button" onclick={loadLaunchers}>{$LL.account_refresh()}</button>
			</div>
		{:else if launchers.length === 0}
			<p class="state-message">
				{$LL.account_launcherEmpty()}
			</p>
		{:else}
			{#if favoriteError}<p class="favorite-error" role="alert">{favoriteError}</p>{/if}
			<div class="launcher-filters">
				<label class="search-field">
					<span class="i-ph-magnifying-glass" aria-hidden="true"></span>
					<span class="sr-only">{$LL.account_launcherSearch()}</span>
					<input bind:value={query} type="search" placeholder={$LL.account_launcherSearch()} />
				</label>
				{#if categories.length > 0}
					<label class="category-field">
						<span class="sr-only">{$LL.account_launcherAllCategories()}</span>
						<select bind:value={category}>
							<option value="">{$LL.account_launcherAllCategories()}</option>
							{#each categories as item (item)}<option value={item}>{item}</option>{/each}
						</select>
					</label>
				{/if}
				<label class="favorite-filter">
					<input bind:checked={favoritesOnly} type="checkbox" />
					<span>{$LL.account_launcherFavorites()}</span>
				</label>
			</div>

			{#if filteredLaunchers.length === 0}
				<p class="state-message">
					{$LL.account_launcherNoMatches()}
				</p>
			{:else}
				<div class="launcher-grid">
					{#each filteredLaunchers as launcher (launcher.id)}
						<article class="launcher-tile" data-width={launcher.grid_width}>
							<a
								class="launcher-link"
								href={launcher.launch_href}
								target={launcher.open_in_new_tab ? '_blank' : undefined}
								rel={launcher.open_in_new_tab ? 'noopener noreferrer' : undefined}
							>
								<div class="launcher-tile__top">
									<div
										class="launcher-icon"
										style={`--launcher-bg: ${launcher.background_color}; --launcher-color: ${launcher.icon_color};`}
									>
										{#if launcher.icon_type === 'image'}
											<img
												src={launcher.icon_value}
												alt=""
												loading="lazy"
												referrerpolicy="no-referrer"
											/>
										{:else}
											<span class={`i-ph-${launcher.icon_value}`} aria-hidden="true"></span>
										{/if}
									</div>
								</div>
								<span class="launcher-name">{launcher.name}</span>
								{#if launcher.description}<span class="launcher-description"
										>{launcher.description}</span
									>{/if}
								<span class="launcher-meta">
									{#if launcher.category}<span>{launcher.category}</span>{/if}
									{#if launcher.launch_type === 'saml_idp_initiated'}<span class="legacy"
											>{$LL.account_launcherLegacy()}</span
										>{/if}
									<span
										class={launcher.open_in_new_tab ? 'i-ph-arrow-square-out' : 'i-ph-arrow-right'}
										aria-hidden="true"
									></span>
								</span>
							</a>
							{#if launcher.allow_favorite}
								<button
									type="button"
									class="favorite-button"
									class:active={launcher.favorite}
									disabled={favoriteLoading.includes(launcher.id)}
									aria-pressed={launcher.favorite}
									aria-label={launcher.favorite
										? $LL.account_launcherFavoriteRemove()
										: $LL.account_launcherFavoriteAdd()}
									onclick={() => toggleFavorite(launcher)}
								>
									<span
										class={launcher.favorite ? 'i-ph-star-fill' : 'i-ph-star'}
										aria-hidden="true"
									></span>
								</button>
							{/if}
						</article>
					{/each}
				</div>
			{/if}
		{/if}
	</section>
</Card>

<style>
	.launcher-panel {
		display: grid;
		gap: 16px;
	}
	.launcher-panel__header {
		display: flex;
		align-items: flex-start;
		justify-content: space-between;
		gap: 16px;
	}
	h2 {
		margin: 0;
		font-size: 1rem;
	}
	.launcher-panel__header p {
		margin: 4px 0 0;
		color: var(--text-muted);
		font-size: 0.8125rem;
	}
	.count {
		min-width: 28px;
		padding: 3px 8px;
		border-radius: 999px;
		background: var(--surface-secondary);
		color: var(--text-muted);
		font-size: 0.75rem;
		text-align: center;
	}
	.launcher-filters {
		display: flex;
		align-items: center;
		flex-wrap: wrap;
		gap: 8px;
	}
	.search-field {
		position: relative;
		flex: 1 1 220px;
	}
	.search-field > span:first-child {
		position: absolute;
		top: 50%;
		left: 11px;
		transform: translateY(-50%);
		color: var(--text-muted);
		pointer-events: none;
	}
	input[type='search'],
	select {
		min-height: 38px;
		width: 100%;
		border: 1px solid var(--border);
		border-radius: 8px;
		background: var(--surface);
		color: var(--text);
		font: inherit;
	}
	input[type='search'] {
		padding: 8px 12px 8px 34px;
	}
	select {
		min-width: 160px;
		padding: 8px 30px 8px 10px;
	}
	input:focus-visible,
	select:focus-visible,
	button:focus-visible,
	a:focus-visible {
		outline: 2px solid var(--primary);
		outline-offset: 2px;
	}
	.favorite-filter {
		min-height: 38px;
		display: inline-flex;
		align-items: center;
		gap: 7px;
		padding: 0 10px;
		border: 1px solid var(--border);
		border-radius: 8px;
		color: var(--text-muted);
		font-size: 0.8125rem;
		cursor: pointer;
	}
	.launcher-grid {
		display: grid;
		grid-template-columns: repeat(8, minmax(0, 1fr));
		gap: 10px;
	}
	.launcher-tile {
		position: relative;
		min-width: 0;
		border: 1px solid var(--border);
		border-radius: 10px;
		background: var(--surface);
	}
	.launcher-tile[data-width='1'] {
		grid-column: span 1;
	}
	.launcher-tile[data-width='2'] {
		grid-column: span 2;
	}
	.launcher-tile[data-width='3'] {
		grid-column: span 3;
	}
	.launcher-tile[data-width='4'] {
		grid-column: span 4;
	}
	.launcher-tile[data-width='5'] {
		grid-column: span 5;
	}
	.launcher-tile[data-width='6'] {
		grid-column: span 6;
	}
	.launcher-tile[data-width='7'] {
		grid-column: span 7;
	}
	.launcher-tile[data-width='8'] {
		grid-column: span 8;
	}
	.launcher-tile:hover {
		border-color: color-mix(in srgb, var(--primary) 45%, var(--border));
		box-shadow: 0 4px 12px rgb(15 23 42 / 0.08);
	}
	.launcher-tile__top {
		display: flex;
		align-items: flex-start;
		min-height: 42px;
	}
	.launcher-icon {
		width: 42px;
		height: 42px;
		display: grid;
		place-items: center;
		flex: none;
		overflow: hidden;
		border-radius: 9px;
		background: var(--launcher-bg);
		color: var(--launcher-color);
	}
	.launcher-icon span {
		width: 22px;
		height: 22px;
	}
	.launcher-icon img {
		width: 100%;
		height: 100%;
		object-fit: cover;
	}
	.favorite-button {
		position: absolute;
		top: 14px;
		right: 14px;
		z-index: 1;
		width: 32px;
		height: 32px;
		display: grid;
		place-items: center;
		padding: 0;
		border: 0;
		border-radius: 7px;
		background: transparent;
		color: var(--text-muted);
		cursor: pointer;
	}
	.favorite-button:hover {
		background: var(--surface-secondary);
		color: var(--text);
	}
	.favorite-button.active {
		color: #d97706;
	}
	.favorite-button:disabled {
		opacity: 0.5;
		cursor: wait;
	}
	.launcher-link {
		display: grid;
		gap: 5px;
		height: 100%;
		min-width: 0;
		padding: 14px;
		border-radius: inherit;
		color: inherit;
		text-decoration: none;
	}
	.launcher-link .launcher-name {
		margin-top: 7px;
	}
	.launcher-name {
		font-weight: 650;
		overflow-wrap: anywhere;
	}
	.launcher-description {
		display: -webkit-box;
		overflow: hidden;
		color: var(--text-muted);
		font-size: 0.8125rem;
		line-height: 1.35;
		line-clamp: 2;
		-webkit-box-orient: vertical;
		-webkit-line-clamp: 2;
	}
	.launcher-meta {
		display: flex;
		align-items: center;
		gap: 7px;
		margin-top: 3px;
		color: var(--text-muted);
		font-size: 0.75rem;
	}
	.launcher-meta > span:last-child {
		margin-left: auto;
	}
	.legacy {
		padding: 1px 5px;
		border-radius: 4px;
		background: #fef3c7;
		color: #92400e;
		font-weight: 650;
	}
	.state-message {
		margin: 0;
		padding: 18px;
		border: 1px dashed var(--border);
		border-radius: 8px;
		color: var(--text-muted);
		text-align: center;
	}
	.favorite-error {
		margin: 0;
		padding: 9px 11px;
		border-radius: 8px;
		background: color-mix(in srgb, var(--error, #b91c1c) 9%, transparent);
		color: var(--error, #b91c1c);
		font-size: 0.8125rem;
	}
	.state-message p {
		margin: 0 0 10px;
	}
	.state-message button {
		border: 1px solid var(--border);
		border-radius: 7px;
		padding: 7px 12px;
		background: var(--surface);
		color: var(--text);
		cursor: pointer;
	}
	.launcher-skeleton {
		grid-column: span 2;
		height: 138px;
		padding: 14px;
		border: 1px solid var(--border);
		border-radius: 10px;
	}
	.launcher-skeleton span,
	.launcher-skeleton i {
		display: block;
		background: var(--surface-secondary);
	}
	.launcher-skeleton span {
		width: 42px;
		height: 42px;
		border-radius: 9px;
	}
	.launcher-skeleton i {
		width: 70%;
		height: 10px;
		margin-top: 14px;
		border-radius: 4px;
	}
	.launcher-skeleton i:last-child {
		width: 45%;
		margin-top: 8px;
	}
	.sr-only {
		position: absolute;
		width: 1px;
		height: 1px;
		padding: 0;
		overflow: hidden;
		clip: rect(0, 0, 0, 0);
		white-space: nowrap;
		border: 0;
	}
	@media (max-width: 900px) {
		.launcher-grid {
			grid-template-columns: repeat(4, minmax(0, 1fr));
		}
		.launcher-tile[data-width='5'],
		.launcher-tile[data-width='6'],
		.launcher-tile[data-width='7'],
		.launcher-tile[data-width='8'] {
			grid-column: span 4;
		}
		.launcher-skeleton {
			grid-column: span 2;
		}
	}
	@media (max-width: 600px) {
		.launcher-grid {
			grid-template-columns: repeat(2, minmax(0, 1fr));
		}
		.launcher-tile[data-width='3'],
		.launcher-tile[data-width='4'],
		.launcher-tile[data-width='5'],
		.launcher-tile[data-width='6'],
		.launcher-tile[data-width='7'],
		.launcher-tile[data-width='8'] {
			grid-column: span 2;
		}
		.launcher-skeleton {
			grid-column: span 2;
		}
		.category-field {
			flex: 1 1 150px;
		}
	}
</style>
