export class AdminLoginTimeoutError extends Error {
	constructor() {
		super('admin_login_timeout');
		this.name = 'AdminLoginTimeoutError';
	}
}

export async function withAdminLoginTimeout<T>(
	operation: Promise<T>,
	timeoutMs: number,
	onTimeout?: () => void
): Promise<T> {
	if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1) {
		throw new TypeError('admin_login_timeout_invalid');
	}

	let timeout: ReturnType<typeof setTimeout> | undefined;
	const deadline = new Promise<never>((_resolve, reject) => {
		timeout = setTimeout(() => {
			try {
				onTimeout?.();
			} finally {
				reject(new AdminLoginTimeoutError());
			}
		}, timeoutMs);
	});

	try {
		return await Promise.race([operation, deadline]);
	} finally {
		if (timeout !== undefined) clearTimeout(timeout);
	}
}
