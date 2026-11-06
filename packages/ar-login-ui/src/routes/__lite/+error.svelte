<script lang="ts">
	import { page } from '$app/state';
	import LiteShell from '#lib/lite/LiteShell.svelte';

	// The lite frame for errors; the strings come from the layout (lite +layout.server.ts).
	const data = $derived(
		page.data as {
			brandName?: string;
			logo?: string | null;
			errorText?: { title: string; message: string; back: string };
		}
	);
</script>

<LiteShell
	title={data.errorText?.title ?? 'Error'}
	brandName={data.brandName ?? ''}
	logo={data.logo ?? null}
>
	<h1>{data.errorText?.title ?? 'Error'}</h1>
	<p>{data.errorText?.message ?? ''}</p>
	<p><a href="/login">{data.errorText?.back ?? 'Back'}</a></p>
</LiteShell>
