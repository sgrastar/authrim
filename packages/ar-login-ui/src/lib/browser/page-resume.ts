export function installPageResumeHandler(callback: () => void | Promise<void>): () => void {
	let wasHidden = document.visibilityState === 'hidden';
	let running = false;

	const run = async () => {
		if (running) return;
		running = true;
		try {
			await callback();
		} finally {
			running = false;
		}
	};

	const handleVisibilityChange = () => {
		if (document.visibilityState === 'hidden') {
			wasHidden = true;
			return;
		}
		if (!wasHidden) return;
		wasHidden = false;
		void run();
	};

	const handlePageShow = (event: PageTransitionEvent) => {
		if (!event.persisted) return;
		wasHidden = false;
		void run();
	};

	document.addEventListener('visibilitychange', handleVisibilityChange);
	window.addEventListener('pageshow', handlePageShow);

	return () => {
		document.removeEventListener('visibilitychange', handleVisibilityChange);
		window.removeEventListener('pageshow', handlePageShow);
	};
}
