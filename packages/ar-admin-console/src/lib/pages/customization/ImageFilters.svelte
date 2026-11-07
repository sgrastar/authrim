<script lang="ts" module>
	import {
		LOGIN_UI_IMAGE_FILTER_NAMES,
		LOGIN_UI_IMAGE_FILTERS,
		type LoginUIImageFilter,
		type LoginUIImageFilterName
	} from '@authrim/ar-lib-core/utils/login-ui-image-filters';
	import type { MenuAction } from '#lib/ui/primitives/ActionMenu.svelte';
	import { t } from '#lib/i18n/i18n.svelte.js';

	/** A filter's name as the editor shows it. */
	export const filterLabel = (name: LoginUIImageFilterName) => t(`th.f.${name}`);

	/**
	 * The menu that adds a filter: each one not added yet, added at its starting value at the end
	 * of the list (filters apply in the order they were added).
	 */
	export function addFilterActions(
		filters: readonly LoginUIImageFilter[],
		onadd: (filter: LoginUIImageFilter) => void
	): MenuAction[] {
		return LOGIN_UI_IMAGE_FILTER_NAMES.map((name) => ({
			label: filterLabel(name),
			disabled: filters.some((filter) => filter.name === name),
			onselect: () => onadd({ name, value: LOGIN_UI_IMAGE_FILTERS[name].initial })
		}));
	}
</script>

<script lang="ts">
	import IconButton from '#lib/ui/primitives/IconButton.svelte';
	import Slider from '#lib/ui/primitives/Slider.svelte';

	/** The filters on a picture: a slider for each, with a button that removes it. */
	let { filters = $bindable() }: { filters: LoginUIImageFilter[] } = $props();

	function remove(name: LoginUIImageFilterName) {
		filters = filters.filter((filter) => filter.name !== name);
	}
</script>

{#if filters.length}
	<ul class="filters">
		{#each filters as filter, index (filter.name)}
			{@const spec = LOGIN_UI_IMAGE_FILTERS[filter.name]}
			<li class="filters__row">
				<div class="filters__slider">
					<Slider
						label={filterLabel(filter.name)}
						min={spec.min}
						max={spec.max}
						format={spec.unit === '%' ? 'percent' : 'number'}
						unit={spec.unit === 'px' ? 'px' : spec.unit === 'deg' ? '°' : undefined}
						dense
						bind:value={filters[index].value}
					/>
				</div>
				<IconButton
					icon="trash"
					size="sm"
					label={t('th.f.remove', { name: filterLabel(filter.name) })}
					onclick={() => remove(filter.name)}
				/>
			</li>
		{/each}
	</ul>
{/if}

<style>
	.filters {
		display: grid;
		gap: var(--space-related);
		margin: 0;
		padding: 0;
		list-style: none;
	}

	.filters__row {
		display: flex;
		align-items: center;
		gap: var(--space-related);
	}

	.filters__slider {
		flex: 1;
		min-width: 0;
	}
</style>
