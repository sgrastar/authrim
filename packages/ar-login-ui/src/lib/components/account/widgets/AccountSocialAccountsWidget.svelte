<script lang="ts">
	/** Connected social accounts. A placeholder until the account API lists linked identities. */
	import { LL } from '$i18n/i18n-svelte';
	import AccountWidgetPanel from './AccountWidgetPanel.svelte';
	import type { AccountWidgetHeadingLevel } from './types';

	let {
		title = '',
		headingLevel = 2
	}: {
		title?: string;
		headingLevel?: AccountWidgetHeadingLevel;
	} = $props();
</script>

<AccountWidgetPanel title={title || $LL.account_socialAccounts()} {headingLevel}>
	<p class="planned">{$LL.account_planned()}</p>
</AccountWidgetPanel>

<style>
	.planned {
		margin: 0;
		font-size: 0.8125rem;
		color: var(--text-muted);
	}
</style>
