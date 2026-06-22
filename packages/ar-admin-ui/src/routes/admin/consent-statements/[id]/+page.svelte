<script lang="ts">
	import { page } from '$app/stores';
	import ConsentStatementEditor from '../ConsentStatementEditor.svelte';

	const statementId = $derived($page.params.id ?? '');
</script>

<ConsentStatementEditor mode="edit" {statementId} />
