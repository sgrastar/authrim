// See https://svelte.dev/docs/kit/types#app.d.ts
// for information about these interfaces
declare global {
	namespace App {
		// interface Error {}
		// interface Locals {}
		// interface PageData {}
		// interface PageState {}
		interface Platform {
			env?: {
				API_BACKEND_URL?: string;
				ENABLE_API_PROXY?: string;
				[key: string]: string | undefined;
			};
		}
	}
}

declare module 'monaco-editor/esm/vs/editor/editor.api.js' {
	export * from 'monaco-editor/esm/vs/editor/editor.api';
}

declare module 'monaco-editor/esm/vs/basic-languages/html/html.contribution.js' {
	export {};
}

declare module 'monaco-editor/esm/vs/basic-languages/css/css.contribution.js' {
	export {};
}

export {};
