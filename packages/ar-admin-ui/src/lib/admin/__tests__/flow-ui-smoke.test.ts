import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

function readRoute(relativePath: string): string {
	const path = fileURLToPath(new URL(`../../../routes/${relativePath}`, import.meta.url));
	return readFileSync(path, 'utf8');
}

function readComponent(relativePath: string): string {
	const path = fileURLToPath(new URL(`../../components/${relativePath}`, import.meta.url));
	return readFileSync(path, 'utf8');
}

describe('Flow Admin UI smoke checks', () => {
	it('keeps the flows index focused on saved flows without the overview guide', () => {
		const flowsPage = readRoute('admin/flows/+page.svelte');

		expect(flowsPage).toContain('admin_flows_list_title');
		expect(flowsPage).not.toContain('admin_flows_overview_');
		expect(flowsPage).not.toContain('class="flow-overview"');
	});

	it('keeps palette-added nodes aligned with runtime handle defaults', () => {
		const editorPage = readRoute('admin/flows/[id]/edit/+page.svelte');
		const addNodeBlock = editorPage.slice(
			editorPage.indexOf('function addNode('),
			editorPage.indexOf('function handleConnect(')
		);

		expect(addNodeBlock).toContain(': getDefaultOutputsForKind(kind),');
		expect(addNodeBlock).not.toContain(
			": [{ id: 'default', label: $LL.admin_flows_output_next() }],"
		);
	});

	it('keeps Entry and Complete node handles constrained to one direction', () => {
		const node = readComponent('flow-editor/FlowEditorNode.svelte');

		expect(node).toContain("data.kind !== 'start'");
		expect(node).toContain("data.kind !== 'end'");
	});

	it('keeps Completion Block metadata visible on editor nodes', () => {
		const node = readComponent('flow-editor/FlowEditorNode.svelte');
		const editorPage = readRoute('admin/flows/[id]/edit/+page.svelte');

		expect(node).toContain('data.completionBlock');
		expect(node).toContain('flow-editor-node__block-label');
		expect(editorPage).toContain('completionGroup: FlowEditorGroupNode');
		expect(editorPage).toContain('withCompletionSubflows');
		expect(editorPage).toContain('validateEditorConnection(connection)');
		expect(editorPage).toContain('config.completion_block = node.data.completionBlock');
		expect(editorPage).toContain('completionBlock: getCompletionBlockFromConfig(config)');
	});

	it('keeps Flow assignment UI text behind i18n keys', () => {
		const flowAssignment = readComponent('admin/FlowAssignmentSettings.svelte');
		const consentTarget = readComponent('admin/ConsentPolicyTargetSettings.svelte');

		expect(flowAssignment).not.toContain('getLocale');
		expect(flowAssignment).not.toContain('No Login Flow assigned');
		expect(flowAssignment).not.toContain('Save this target before assigning Flows.');
		expect(consentTarget).not.toContain('Open Flow settings');
		expect(consentTarget).not.toContain('Save consent policy settings');
		expect(consentTarget).not.toContain('First-party application');
	});
});
