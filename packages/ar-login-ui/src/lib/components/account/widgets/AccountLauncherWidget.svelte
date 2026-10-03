<script lang="ts">
	/**
	 * The applications the account can open, as a grid of tiles with search, a category filter and
	 * favourites. The filters are the widget's own state; loading the list and saving a favourite
	 * belong to the caller.
	 */
	import { LL, getLocale } from '$i18n/i18n-svelte';
	import type { AccountLauncher } from '$lib/api/account';
	import { launcherMatchesSearch } from '../account-launcher-filter';
	import AccountWidgetPanel from './AccountWidgetPanel.svelte';
	import type { AccountWidgetHeadingLevel } from './types';

	let {
		launchers = [],
		loading = false,
		error = '',
		favoriteError = '',
		favoriteLoading = [],
		title = '',
		headingLevel = 2,
		onRetry,
		onToggleFavorite
	}: {
		launchers?: AccountLauncher[];
		/** First load: skeleton tiles instead of the (possibly empty) grid. */
		loading?: boolean;
		/** Loading the list failed: replaces the grid, with a retry. */
		error?: string;
		/** Saving a favourite failed: shown above the grid, which stays. */
		favoriteError?: string;
		/** IDs of the launchers whose favourite is being saved; their stars wait. */
		favoriteLoading?: string[];
		title?: string;
		headingLevel?: AccountWidgetHeadingLevel;
		onRetry: () => void;
		onToggleFavorite: (launcher: AccountLauncher) => void;
	} = $props();

	const uid = $props.id();
	let query = $state('');
	let category = $state('');
	let favoritesOnly = $state(false);

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
</script>

<AccountWidgetPanel title={title || $LL.account_launcherTitle()} {headingLevel} busy={loading}>
	{#snippet headingAside()}
		{#if !loading && launchers.length > 0}<span class="count">{launchers.length}</span>{/if}
	{/snippet}

	<p class="description">{$LL.account_launcherDescription()}</p>

	{#if loading}
		<div class="launcher-grid" role="status">
			<span class="sr-only">{$LL.common_loading()}</span>
			{#each Array(4) as _, index (index)}
				<div class="launcher-skeleton" aria-hidden="true"><span></span><i></i><i></i></div>
			{/each}
		</div>
	{:else if error}
		<div class="state-message">
			<p role="alert">{error}</p>
			<button type="button" onclick={() => onRetry()}>{$LL.account_refresh()}</button>
		</div>
	{:else if launchers.length === 0}
		<p class="state-message">{$LL.account_launcherEmpty()}</p>
	{:else}
		{#if favoriteError}<p class="favorite-error" role="alert">{favoriteError}</p>{/if}
		<div class="launcher-filters">
			<div class="search-field">
				<span class="i-ph-magnifying-glass" aria-hidden="true"></span>
				<label class="sr-only" for={`${uid}-search`}>{$LL.account_launcherSearch()}</label>
				<input
					id={`${uid}-search`}
					bind:value={query}
					type="search"
					placeholder={$LL.account_launcherSearch()}
				/>
			</div>
			{#if categories.length > 0}
				<div class="category-field">
					<label class="sr-only" for={`${uid}-category`}>
						{$LL.account_launcherAllCategories()}
					</label>
					<select id={`${uid}-category`} bind:value={category}>
						<option value="">{$LL.account_launcherAllCategories()}</option>
						{#each categories as item (item)}<option value={item}>{item}</option>{/each}
					</select>
				</div>
			{/if}
			<label class="favorite-filter">
				<input bind:checked={favoritesOnly} type="checkbox" />
				<span>{$LL.account_launcherFavorites()}</span>
			</label>
		</div>

		{#if filteredLaunchers.length === 0}
			<p class="state-message">{$LL.account_launcherNoMatches()}</p>
		{:else}
			<ul class="launcher-grid">
				{#each filteredLaunchers as launcher (launcher.id)}
					<li class="launcher-tile" data-width={launcher.grid_width}>
						<a
							class="launcher-link"
							href={launcher.launch_href}
							target={launcher.open_in_new_tab ? '_blank' : undefined}
							rel={launcher.open_in_new_tab ? 'noopener noreferrer' : undefined}
						>
							<span class="launcher-tile__top">
								<span
									class="launcher-icon"
									style:--launcher-bg={launcher.background_color}
									style:--launcher-color={launcher.icon_color}
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
								</span>
							</span>
							<span class="launcher-name">{launcher.name}</span>
							{#if launcher.description}
								<span class="launcher-description">{launcher.description}</span>
							{/if}
							<span class="launcher-meta">
								{#if launcher.category}<span>{launcher.category}</span>{/if}
								{#if launcher.launch_type === 'saml_idp_initiated'}
									<span class="legacy">{$LL.account_launcherLegacy()}</span>
								{/if}
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
								aria-label={`${launcher.name}: ${$LL.account_launcherFavorites()}`}
								title={launcher.favorite
									? $LL.account_launcherFavoriteRemove()
									: $LL.account_launcherFavoriteAdd()}
								onclick={() => onToggleFavorite(launcher)}
							>
								<span class={launcher.favorite ? 'i-ph-star-fill' : 'i-ph-star'} aria-hidden="true"
								></span>
							</button>
						{/if}
					</li>
				{/each}
			</ul>
		{/if}
	{/if}
</AccountWidgetPanel>

<style>
	.description {
		margin: 0;
		color: var(--text-muted);
		font-size: 0.8125rem;
	}
	.count {
		min-width: 28px;
		padding: 3px 8px;
		border-radius: 999px;
		background: var(--bg-subtle);
		color: var(--text-secondary);
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
		background: var(--bg-card);
		color: var(--text-primary);
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
		margin: 0;
		padding: 0;
		list-style: none;
	}
	.launcher-tile {
		position: relative;
		min-width: 0;
		border: 1px solid var(--border);
		border-radius: 10px;
		background: var(--bg-card);
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
		background: var(--bg-subtle);
		color: var(--text-primary);
	}
	.favorite-button.active {
		color: var(--warning-fg);
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
		background: var(--warning-light);
		color: var(--warning-fg);
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
		background: var(--danger-light);
		color: var(--danger-fg);
		font-size: 0.8125rem;
	}
	.state-message p {
		margin: 0 0 10px;
	}
	.state-message button {
		border: 1px solid var(--border);
		border-radius: 7px;
		padding: 7px 12px;
		background: var(--bg-card);
		color: var(--text-primary);
		font: inherit;
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
		background: var(--bg-subtle);
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
		.category-field {
			flex: 1 1 150px;
		}
	}
</style>
