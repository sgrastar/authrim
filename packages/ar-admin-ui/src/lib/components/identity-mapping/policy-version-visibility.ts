export function shouldExposeFieldMappingVersion(input: {
	policyId: string;
	policyLifecycleState: string;
	versionId: string;
	versionLifecycleState: string;
	routePolicyOptionId: string | null;
	selectedPolicyId: string | null;
	selectedVersionId: string | null;
}): boolean {
	if (input.policyLifecycleState === 'active' && input.versionLifecycleState === 'active') {
		return true;
	}
	if (
		input.routePolicyOptionId === `${input.policyId}:${input.versionId}:source` ||
		input.routePolicyOptionId === `${input.policyId}:${input.versionId}:destination`
	) {
		return true;
	}
	return input.policyId === input.selectedPolicyId && input.versionId === input.selectedVersionId;
}

export function resolveMappingEditorLaneSelectorMode(input: {
	configuredMode: 'profile' | 'policy';
	routePolicyOptionId: string | null;
}): 'profile' | 'policy' {
	return input.configuredMode === 'policy' || input.routePolicyOptionId ? 'policy' : 'profile';
}
