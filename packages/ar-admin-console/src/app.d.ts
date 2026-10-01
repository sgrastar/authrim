// See https://svelte.dev/docs/kit/types#app.d.ts
declare global {
	namespace App {
		interface Platform {
			env?: {
				API_BACKEND_URL?: string;
				ENABLE_API_PROXY?: string;
				[key: string]: string | undefined;
			};
		}
	}
}

export {};
