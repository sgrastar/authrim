/**
 * Story tests only (the `storybook` project in vite.config.ts); Storybook itself keeps its motion.
 *
 * The browser already asks for reduced motion, which the console's own animations follow. This
 * covers the plain CSS transitions that have no reduced-motion rule (hover and state colours):
 * with no duration a property takes its final value at once, so the contrast check reads the
 * real colour. Durations are set to zero rather than removing the transitions and animations,
 * so `animationend` still fires for code that waits for it.
 */
const style = document.createElement('style');
style.dataset.storyTests = 'settled';
style.textContent = `
*,
*::before,
*::after {
	transition-duration: 0s !important;
	transition-delay: 0s !important;
}
`;
document.head.append(style);
