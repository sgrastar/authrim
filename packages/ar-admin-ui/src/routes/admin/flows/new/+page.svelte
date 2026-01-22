<script lang="ts">
	import { goto } from '$app/navigation';
	import {
		adminFlowsAPI,
		type ProfileId,
		getProfileDisplayName,
		createEmptyGraphDefinition
	} from '$lib/api/admin-flows';

	let name = $state('');
	let description = $state('');
	let profileId: ProfileId = $state('human-basic');
	let clientId = $state('');

	let saving = $state(false);
	let error = $state('');

	async function handleSubmit(event: Event) {
		event.preventDefault();

		if (!name.trim()) {
			error = 'Name is required';
			return;
		}

		saving = true;
		error = '';

		try {
			const graphDefinition = createEmptyGraphDefinition(name, profileId);

			const result = await adminFlowsAPI.create({
				name: name.trim(),
				description: description.trim() || undefined,
				profile_id: profileId,
				client_id: clientId.trim() || null,
				graph_definition: graphDefinition
			});

			// Navigate to edit page to design the flow
			goto(`/admin/flows/${result.flow_id}/edit`);
		} catch (err) {
			error = err instanceof Error ? err.message : 'Failed to create flow';
		} finally {
			saving = false;
		}
	}

	function handleCancel() {
		goto('/admin/flows');
	}
</script>

<svelte:head>
	<title>Create Flow - Admin Dashboard - Authrim</title>
</svelte:head>

<div class="admin-page">
	<a href="/admin/flows" class="back-link">← Back to Flows</a>

	<h1 class="page-title">Create Flow</h1>
	<p class="modal-description">Create a new authentication or authorization flow.</p>

	{#if error}
		<div class="alert alert-error">{error}</div>
	{/if}

	<form class="panel" onsubmit={handleSubmit}>
		<div class="form-section">
			<h2 class="section-title-border">Basic Information</h2>

			<div class="form-group">
				<label for="name" class="form-label">Name <span class="text-danger">*</span></label>
				<input
					type="text"
					id="name"
					bind:value={name}
					placeholder="Enter flow name"
					required
					class="form-input"
				/>
				<span class="form-hint">A descriptive name for this flow.</span>
			</div>

			<div class="form-group">
				<label for="description" class="form-label">Description</label>
				<textarea
					id="description"
					bind:value={description}
					placeholder="Enter flow description"
					rows="3"
					class="form-input"
				></textarea>
				<span class="form-hint">Optional description explaining the purpose of this flow.</span>
			</div>
		</div>

		<div class="form-section">
			<h2 class="section-title-border">Configuration</h2>

			<div class="form-group">
				<label for="profile" class="form-label"
					>Target Profile <span class="text-danger">*</span></label
				>
				<select id="profile" bind:value={profileId} class="form-select">
					<option value="human-basic">{getProfileDisplayName('human-basic')}</option>
					<option value="human-org">{getProfileDisplayName('human-org')}</option>
					<option value="ai-agent">{getProfileDisplayName('ai-agent')}</option>
					<option value="iot-device">{getProfileDisplayName('iot-device')}</option>
				</select>
				<span class="form-hint">The type of principal this flow targets.</span>
			</div>

			<div class="form-group">
				<label for="client" class="form-label">Client ID</label>
				<input
					type="text"
					id="client"
					bind:value={clientId}
					placeholder="Leave empty for tenant default"
					class="form-input"
				/>
				<span class="form-hint">
					Optionally bind this flow to a specific client. Leave empty to make it the tenant default
					for this profile.
				</span>
			</div>
		</div>

		<div class="form-actions">
			<button type="button" class="btn btn-secondary" onclick={handleCancel} disabled={saving}>
				Cancel
			</button>
			<button type="submit" class="btn btn-primary" disabled={saving}>
				{saving ? 'Creating...' : 'Create and Design'}
			</button>
		</div>
	</form>
</div>
