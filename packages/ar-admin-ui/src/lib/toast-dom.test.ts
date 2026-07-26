// @vitest-environment jsdom

import { describe, expect, it } from 'vitest';
import { findToastSources, readToastSource } from './toast-dom';

describe('Admin toast DOM bridge', () => {
	it.each([
		'alert alert-success',
		'alert alert--success',
		'alert success',
		'message success',
		'notice success'
	])('recognizes and normalizes the legacy success class %s', (className) => {
		const element = document.createElement('div');
		element.className = className;
		element.innerHTML = '  Settings <strong>saved</strong>.  ';

		expect(readToastSource(element)).toMatchObject({
			tone: 'success',
			message: 'Settings saved.'
		});
	});

	it('recognizes legacy error alerts without removing their source', () => {
		const element = document.createElement('div');
		element.className = 'alert alert-error';
		element.textContent = 'Unable to save settings.';

		const source = readToastSource(element);
		expect(source).toMatchObject({ tone: 'error', message: 'Unable to save settings.' });
		expect(source?.element).toBe(element);
		expect(element.isConnected).toBe(false);
	});

	it('supports explicit toast sources for future pages', () => {
		const element = document.createElement('div');
		element.dataset.adminToast = 'success';
		element.dataset.adminToastMessage = 'Published successfully.';
		element.textContent = 'Ignored visible text';

		expect(readToastSource(element)).toMatchObject({
			tone: 'success',
			message: 'Published successfully.'
		});
	});

	it('does not turn generic warning alerts into error toasts', () => {
		const element = document.createElement('div');
		element.className = 'alert alert-warning';
		element.setAttribute('role', 'alert');
		element.textContent = 'Review this setting.';

		expect(readToastSource(element)).toBeNull();
	});

	it('ignores rendered toasts and explicitly ignored regions', () => {
		const viewport = document.createElement('div');
		viewport.dataset.adminToastViewport = '';
		viewport.innerHTML = '<div class="alert alert-error">Do not repeat</div>';

		const ignored = document.createElement('div');
		ignored.dataset.adminToastIgnore = '';
		ignored.innerHTML = '<div class="alert alert-error">Keep inline only</div>';

		expect(findToastSources(viewport)).toEqual([]);
		expect(findToastSources(ignored)).toEqual([]);
	});

	it('finds both a root source and nested sources', () => {
		const root = document.createElement('div');
		root.className = 'notice success';
		root.textContent = 'Saved';
		expect(findToastSources(root)).toHaveLength(1);

		const container = document.createElement('section');
		container.innerHTML = `
			<div class="message success">Updated</div>
			<div class="alert alert-error">Failed</div>
		`;
		expect(findToastSources(container).map(({ tone }) => tone)).toEqual(['success', 'error']);
	});
});
