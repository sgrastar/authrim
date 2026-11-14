<script lang="ts">
	import { t } from '#lib/i18n/i18n.svelte.js';
	import Card from '#lib/ui/patterns/Card.svelte';
	import MappingEditor from '#lib/ui/patterns/MappingEditor.svelte';
	import { provideSaveScope } from '#lib/ui/save/save-scope.js';
	import type { ConnectionMapping } from './connection-mapping.sample';

	/**
	 * A connection's one mapping, on its service flow's main screen: a provider's attributes into
	 * Authrim's (inbound), or Authrim's into what an app receives (outbound). Shown only for
	 * now: nothing is saved.
	 */
	interface Props {
		mapping: ConnectionMapping;
	}

	let { mapping = $bindable() }: Props = $props();

	// Not part of the connection's draft yet: what is typed here (a problem in it too) must not
	// mark the page changed or stop the connection's own settings from saving.
	provideSaveScope({ original: () => undefined });
	const COPY = {
		inbound: {
			title: 'sf.maps.in.title',
			description: 'sf.maps.in.description',
			label: 'sf.maps.in.label'
		},
		outbound: {
			title: 'sf.maps.out.title',
			description: 'sf.maps.out.description',
			label: 'sf.maps.out.label'
		}
	} as const;
	const copy = $derived(COPY[mapping.direction]);
</script>

<Card title={t(copy.title)} description={t(copy.description)}>
	<MappingEditor
		label={t(copy.label)}
		direction={mapping.direction}
		sources={mapping.sources}
		targets={mapping.targets}
		bind:mappings={mapping.mappings}
	/>
</Card>
