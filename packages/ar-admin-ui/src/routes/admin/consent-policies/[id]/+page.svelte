<script lang="ts">
	import { page } from '$app/stores';
	import PolicyEditor from '../PolicyEditor.svelte';

	const policyId = $derived($page.params.id ?? '');
</script>

<PolicyEditor mode="edit" {policyId} />
