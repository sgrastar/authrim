<script lang="ts">
	import type { TenantCopyOptions } from '#lib/api/tenants.js';
	import { t } from '#lib/i18n/i18n.svelte.js';
	import Badge from '#lib/ui/primitives/Badge.svelte';
	import Checkbox from '#lib/ui/primitives/Checkbox.svelte';
	import { COPY_GROUPS, setCopyPart, type CopyItem } from './tenant-model';

	/**
	 * What a copy takes from its source, in three groups (configuration, applications, people).
	 * A secret is offered under what holds it and only with it. What the copy cannot take yet
	 * (flows, screens, end users…) is listed as well, unchecked and marked "In development", so
	 * the admin sees it will not come along.
	 */
	interface Props {
		options: TenantCopyOptions;
	}

	let { options = $bindable() }: Props = $props();

	const checked = (item: CopyItem) => (item.part ? options[item.part] : false);
</script>

<div class="copy">
	{#each COPY_GROUPS as group (group.id)}
		<fieldset class="copy__group">
			<legend class="copy__legend">{t(group.label)}</legend>
			{#each group.items as item (item.id)}
				<div class="copy__item" class:copy__item--sub={item.requires !== undefined}>
					{#if item.part}
						{@const part = item.part}
						<Checkbox
							checked={checked(item)}
							description={t(item.description)}
							onchange={(event) =>
								(options = setCopyPart(options, part, event.currentTarget.checked))}
						>
							{t(item.label)}
						</Checkbox>
					{:else}
						<Checkbox checked={false} disabled description={t(item.description)}>
							<span class="copy__label">
								{t(item.label)}
								<Badge size="sm">{t('tn.copy.inDevelopment')}</Badge>
							</span>
						</Checkbox>
					{/if}
				</div>
			{/each}
		</fieldset>
	{/each}
</div>

<style>
	.copy {
		display: grid;
		gap: var(--space-section);
	}

	.copy__group {
		display: grid;
		gap: var(--space-related);
		margin: 0;
		padding: 0;
		border: 0;
	}

	.copy__legend {
		margin-bottom: var(--space-related);
		padding: 0;
		font-size: var(--fs-small);
		font-weight: var(--fw-semibold);
		color: var(--text-secondary);
	}

	.copy__item--sub {
		padding-inline-start: 1.75em;
	}

	.copy__label {
		display: inline-flex;
		align-items: center;
		gap: 0.5em;
	}
</style>
