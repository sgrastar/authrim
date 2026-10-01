/**
 * One shape for every failed Admin API call, so pages handle failures the same way:
 *   403  → the admin may not do this (the page shows "no access", not an error)
 *   404  → it does not exist (any more)
 *   409  → someone else changed it since it was loaded (ConflictError)
 *   400 with per-key reasons → some values were refused (RejectedError)
 *   else → something went wrong; the page offers to try again
 * The API answers `{ error, message | error_description, ...details }`.
 */
export class ApiError extends Error {
	readonly status: number;
	/** The API's machine-readable code (`forbidden`, `validation_failed`…); '' when none. */
	readonly code: string;
	readonly body: Record<string, unknown>;

	constructor(status: number, code: string, message: string, body: Record<string, unknown> = {}) {
		super(message);
		this.name = 'ApiError';
		this.status = status;
		this.code = code;
		this.body = body;
	}

	get forbidden(): boolean {
		return this.status === 403;
	}

	get notFound(): boolean {
		return this.status === 404;
	}
}

/** The version sent with a change is not the current one: reload, then apply again. */
export class ConflictError extends ApiError {
	readonly currentVersion: string;

	constructor(message: string, body: Record<string, unknown>) {
		super(409, 'conflict', message, body);
		this.name = 'ConflictError';
		this.currentVersion = typeof body.currentVersion === 'string' ? body.currentVersion : '';
	}
}

/** Every value in the change was refused; `rejected` says why, per key. */
export class RejectedError extends ApiError {
	readonly rejected: Readonly<Record<string, string>>;

	constructor(message: string, body: Record<string, unknown>) {
		super(400, 'validation_failed', message, body);
		this.name = 'RejectedError';
		this.rejected = isReasons(body.rejected) ? body.rejected : {};
	}
}

function isReasons(value: unknown): value is Record<string, string> {
	return (
		value !== null &&
		typeof value === 'object' &&
		Object.values(value).every((reason) => typeof reason === 'string')
	);
}

/** The error a failed response stands for. */
export async function errorFromResponse(response: Response): Promise<ApiError> {
	const body = await response
		.json()
		.then((data: unknown) =>
			data !== null && typeof data === 'object' ? (data as Record<string, unknown>) : {}
		)
		.catch(() => ({}) as Record<string, unknown>);
	const code = typeof body.error === 'string' ? body.error : '';
	const message =
		(typeof body.message === 'string' && body.message) ||
		(typeof body.error_description === 'string' && body.error_description) ||
		`${response.status} ${response.statusText}`.trim();
	if (response.status === 409) return new ConflictError(message, body);
	if (response.status === 400 && code === 'validation_failed')
		return new RejectedError(message, body);
	return new ApiError(response.status, code, message, body);
}
