<script lang="ts">
	import ProgressBar from '../primitives/ProgressBar.svelte';
	import { sample } from './sample';

	/** Storybook demo: a task that moves from unknown duration to measured progress. */
	let value = $state(0);

	$effect(() => {
		const timer = setInterval(() => {
			value = value >= 100 ? 0 : value + 7;
		}, 400);
		return () => clearInterval(timer);
	});
</script>

<div style="display:grid;gap:18px;max-width:420px">
	<ProgressBar label={sample('preparing')} showLabel />
	<ProgressBar label={sample('uploading')} value={Math.min(value, 100)} showLabel showValue />
</div>
