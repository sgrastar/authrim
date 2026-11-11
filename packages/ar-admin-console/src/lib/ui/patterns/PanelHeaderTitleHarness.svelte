<script lang="ts">
	import { tick } from 'svelte';
	import BackLink from '../primitives/BackLink.svelte';
	import IconButton from '../primitives/IconButton.svelte';
	import PanelHeader from './PanelHeader.svelte';
	import TitleEditor from './TitleEditor.svelte';

	/** Storybook only: a panel header whose title is edited in place with its pencil. */
	let { initial = 'Screen' }: { initial?: string } = $props();

	// svelte-ignore state_referenced_locally
	let title = $state(initial);
	let editing = $state(false);
	let button = $state<HTMLButtonElement>();
	function close() {
		editing = false;
		void tick().then(() => button?.focus());
	}
</script>

{#snippet action()}
	<IconButton
		icon="pencil"
		size="sm"
		label="Edit the title"
		bind:element={button}
		onclick={() => (editing = true)}
	/>
{/snippet}

{#snippet editor()}
	<TitleEditor
		value={title}
		label="Title"
		hint="A name to tell it apart in the flow (up to 40 characters)."
		requiredMessage="Enter a title."
		maxlength={40}
		doneLabel="Done"
		ondone={(value) => {
			title = value;
			close();
		}}
		oncancel={close}
	/>
{/snippet}

<PanelHeader
	{title}
	titleAction={editing ? undefined : action}
	titleEditor={editing ? editor : undefined}
>
	{#snippet back()}<BackLink>Flow-wide settings</BackLink>{/snippet}
</PanelHeader>
