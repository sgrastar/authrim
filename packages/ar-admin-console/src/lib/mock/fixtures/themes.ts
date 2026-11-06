import { createFakeLoginUiThemes } from '#lib/api/fake/login-ui-themes-fake.js';

/**
 * The mock's saved themes: none at first, as for a new tenant. What is created, saved, applied or
 * deleted stays while the mock is open.
 */
export const mockThemes = createFakeLoginUiThemes({ delay: 150 });

/** The mock has no asset store: a chosen image is shown from the browser's own copy. */
export async function mockUploadAsset(_kind: string, file: File): Promise<string> {
	return URL.createObjectURL(file);
}
