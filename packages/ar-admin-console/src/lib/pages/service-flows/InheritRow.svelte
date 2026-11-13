<script lang="ts">
	import type { Snippet } from 'svelte';
	import { t } from '#lib/i18n/i18n.svelte.js';
	import InheritedSetting from '#lib/ui/patterns/InheritedSetting.svelte';
	import {
		setOverride,
		usesDefault,
		type SpInheritKey,
		type SpSettings
	} from './connection-settings';

	/**
	 * A connection setting that may have a default above it (the platform's, or the tenant's
	 * service defaults). With one, the control shows it until "Override for this connection";
	 * without one, there is nothing to fall back to and the control is shown as it is.
	 */
	interface Props {
		settings: SpSettings;
		key: SpInheritKey;
		/** The default as people read it. */
		format: (value: string | number | boolean | null) => string;
		children: Snippet<[{ inherited: boolean }]>;
	}

	let { settings = $bindable(), key, format, children: control }: Props = $props();

	const inherited = $derived(settings.inherited[key]);
</script>

{#if inherited}
	<InheritedSetting
		overridden={!usesDefault(settings, key)}
		defaultValue={format(inherited.value)}
		source={t(inherited.source === 'platform' ? 'inherit.sourcePlatform' : 'cs.inherit.service')}
		target={t('cs.inherit.target')}
		onchange={(own) => setOverride(settings, key, own)}
	>
		<!-- Back on the default, the control is built again: what was typed into it (an invalid
		     value, its error) goes with the override. -->
		{#snippet children({ inherited: locked })}{#key locked}{@render control({
					inherited: locked
				})}{/key}{/snippet}
	</InheritedSetting>
{:else}
	{@render control({ inherited: false })}
{/if}
