<script module lang="ts">
	import { defineMeta } from '@storybook/addon-svelte-csf';
	import ThemeTransitionDemo from '../stories/ThemeTransitionDemo.svelte';

	const { Story } = defineMeta({
		title: 'Tokens/Theme transition',
		component: ThemeTransitionDemo,
		parameters: {
			docs: {
				description: {
					component:
						'The light ↔ dark transition from the redesign mock. Colour tokens are registered with `@property` and interpolated at the root (1.8 s, `cubic-bezier(0.5, 0.2, 0.7, 0.95)` so perceived lightness moves in even steps), while a single wash covers the screen (2.28 s) so elements reaching their final colour at slightly different times read as one change. Tokens are animated rather than elements because `color` is inherited: transitioning it per element makes children chase their parents and snap at the end. Disabled under reduced motion.'
				}
			}
		}
	});
</script>

<Story name="Light ↔ dark" exportName="LightDark" />
