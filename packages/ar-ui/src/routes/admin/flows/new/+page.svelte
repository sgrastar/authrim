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

<div class="new-flow-page">
	<div class="page-header">
		<h1>Create Flow</h1>
		<p class="description">Create a new authentication or authorization flow.</p>
	</div>

	{#if error}
		<div class="error-banner">
			<span>{error}</span>
		</div>
	{/if}

	<form class="flow-form" onsubmit={handleSubmit}>
		<div class="form-section">
			<h2>Basic Information</h2>

			<div class="form-group">
				<label for="name">Name <span class="required">*</span></label>
				<input type="text" id="name" bind:value={name} placeholder="Enter flow name" required />
				<span class="help-text">A descriptive name for this flow.</span>
			</div>

			<div class="form-group">
				<label for="description">Description</label>
				<textarea
					id="description"
					bind:value={description}
					placeholder="Enter flow description"
					rows="3"
				></textarea>
				<span class="help-text">Optional description explaining the purpose of this flow.</span>
			</div>
		</div>

		<div class="form-section">
			<h2>Configuration</h2>

			<div class="form-group">
				<label for="profile">Target Profile <span class="required">*</span></label>
				<select id="profile" bind:value={profileId}>
					<option value="human-basic">{getProfileDisplayName('human-basic')}</option>
					<option value="human-org">{getProfileDisplayName('human-org')}</option>
					<option value="ai-agent">{getProfileDisplayName('ai-agent')}</option>
					<option value="iot-device">{getProfileDisplayName('iot-device')}</option>
				</select>
				<span class="help-text">The type of principal this flow targets.</span>
			</div>

			<div class="form-group">
				<label for="client">Client ID</label>
				<input
					type="text"
					id="client"
					bind:value={clientId}
					placeholder="Leave empty for tenant default"
				/>
				<span class="help-text">
					Optionally bind this flow to a specific client. Leave empty to make it the tenant default
					for this profile.
				</span>
			</div>
		</div>

		<div class="form-actions">
			<button type="button" class="btn-secondary" onclick={handleCancel} disabled={saving}>
				Cancel
			</button>
			<button type="submit" class="btn-primary" disabled={saving}>
				{saving ? 'Creating...' : 'Create and Design'}
			</button>
		</div>
	</form>
</div>

<style>
	.new-flow-page {
		padding: 24px;
		max-width: 800px;
		margin: 0 auto;
	}

	.page-header {
		margin-bottom: 24px;
	}

	.page-header h1 {
		margin: 0 0 8px 0;
		font-size: 24px;
		font-weight: 600;
	}

	.description {
		margin: 0;
		color: #6b7280;
		font-size: 14px;
	}

	.error-banner {
		background-color: #fef2f2;
		border: 1px solid #fecaca;
		color: #b91c1c;
		padding: 12px 16px;
		border-radius: 6px;
		margin-bottom: 16px;
	}

	.flow-form {
		background-color: white;
		border: 1px solid #e5e7eb;
		border-radius: 8px;
		padding: 24px;
	}

	.form-section {
		margin-bottom: 32px;
	}

	.form-section:last-of-type {
		margin-bottom: 0;
	}

	.form-section h2 {
		margin: 0 0 16px 0;
		font-size: 18px;
		font-weight: 600;
		padding-bottom: 8px;
		border-bottom: 1px solid #e5e7eb;
	}

	.form-group {
		margin-bottom: 20px;
	}

	.form-group:last-child {
		margin-bottom: 0;
	}

	.form-group label {
		display: block;
		margin-bottom: 6px;
		font-size: 14px;
		font-weight: 500;
		color: #374151;
	}

	.required {
		color: #dc2626;
	}

	.form-group input,
	.form-group select,
	.form-group textarea {
		width: 100%;
		padding: 10px 12px;
		border: 1px solid #d1d5db;
		border-radius: 6px;
		font-size: 14px;
		transition: border-color 0.2s;
	}

	.form-group input:focus,
	.form-group select:focus,
	.form-group textarea:focus {
		outline: none;
		border-color: #2563eb;
		box-shadow: 0 0 0 3px rgba(37, 99, 235, 0.1);
	}

	.form-group textarea {
		resize: vertical;
		min-height: 80px;
	}

	.help-text {
		display: block;
		margin-top: 6px;
		font-size: 13px;
		color: #6b7280;
	}

	.form-actions {
		display: flex;
		justify-content: flex-end;
		gap: 12px;
		margin-top: 32px;
		padding-top: 24px;
		border-top: 1px solid #e5e7eb;
	}

	.btn-primary {
		padding: 10px 20px;
		background-color: #2563eb;
		color: white;
		border: none;
		border-radius: 6px;
		font-size: 14px;
		font-weight: 500;
		cursor: pointer;
		transition: background-color 0.2s;
	}

	.btn-primary:hover {
		background-color: #1d4ed8;
	}

	.btn-primary:disabled {
		opacity: 0.5;
		cursor: not-allowed;
	}

	.btn-secondary {
		padding: 10px 20px;
		background-color: white;
		color: #374151;
		border: 1px solid #d1d5db;
		border-radius: 6px;
		font-size: 14px;
		font-weight: 500;
		cursor: pointer;
		transition: background-color 0.2s;
	}

	.btn-secondary:hover {
		background-color: #f3f4f6;
	}

	.btn-secondary:disabled {
		opacity: 0.5;
		cursor: not-allowed;
	}
</style>
