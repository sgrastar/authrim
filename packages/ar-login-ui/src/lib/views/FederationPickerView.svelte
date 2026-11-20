<script module lang="ts">
	/** An institution of a federation the person may sign in through. */
	export interface FederationIdP {
		entityId: string;
		displayName: string;
		logoUrl: string | null;
	}
</script>

<script lang="ts">
	/**
	 * The institution picker of a SAML federation: the person types part of their institution's
	 * name and chooses it from the list, then signs in there. The route owns the search and the
	 * hand-over to the SAML start; this view draws the box, the results and the states.
	 */
	import { Alert, Card } from '#lib/components/index.js';
	import { LL } from '$i18n/i18n-svelte';
	import { isValidImageUrl } from '#lib/utils/url-validation.js';

	type Props = {
		/** The federation's name, as the tenant calls it. */
		federationName: string;
		items: FederationIdP[];
		query: string;
		loading?: boolean;
		/** The list could not be read (not the same as no match). */
		loadFailed?: boolean;
		/** More institutions match than are shown. */
		truncated?: boolean;
		onSelect: (entityId: string) => void;
		onQuery?: (query: string) => void;
	};

	let {
		federationName,
		items,
		query = $bindable(''),
		loading = false,
		loadFailed = false,
		truncated = false,
		onSelect,
		onQuery
	}: Props = $props();
</script>

<Card>
	<div class="auth-discover">
		<div class="auth-discover__header">
			<p class="auth-discover__kicker">{federationName}</p>
			<h2 class="auth-section-title">{$LL.federation_picker_title()}</h2>
			<p class="auth-section-subtitle">{$LL.federation_picker_subtitle()}</p>
		</div>

		{#if loadFailed}
			<Alert variant="error">{$LL.federation_picker_loadError()}</Alert>
		{/if}

		<div class="form-group">
			<label class="auth-discover__label" for="federation-search"
				>{$LL.federation_picker_searchLabel()}</label
			>
			<input
				id="federation-search"
				class="form-input"
				type="search"
				autocomplete="off"
				autocapitalize="off"
				spellcheck="false"
				placeholder={$LL.federation_picker_searchPlaceholder()}
				bind:value={query}
				oninput={() => onQuery?.(query)}
			/>
		</div>

		<div class="tenant-options" aria-live="polite" aria-busy={loading}>
			{#each items as item (item.entityId)}
				<button
					type="button"
					class="tenant-option tenant-option-button"
					onclick={() => onSelect(item.entityId)}
				>
					<div class="tenant-branding">
						{#if item.logoUrl && isValidImageUrl(item.logoUrl)}
							<img src={item.logoUrl} alt="" />
						{/if}
						<div>
							<strong>{item.displayName}</strong>
						</div>
					</div>
				</button>
			{/each}
			{#if !loading && !loadFailed && items.length === 0}
				<p class="auth-section-subtitle">{$LL.federation_picker_noResults()}</p>
			{/if}
			{#if truncated}
				<p class="auth-section-subtitle">{$LL.federation_picker_more()}</p>
			{/if}
		</div>

		<a class="auth-discover__label" href="/login" data-sveltekit-reload>
			{$LL.federation_picker_back()}
		</a>
	</div>
</Card>
