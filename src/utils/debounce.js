/**
 * @template {(...args: any[]) => void} T
 * @param {T} fn
 * @param {number} delayMs
 * @returns {(...args: Parameters<T>) => void}
 */
function debounce(fn, delayMs) {
	/** @type {NodeJS.Timeout | undefined} */
	let timer;

	return (...args) => {
		if (timer) {
			clearTimeout(timer);
		}

		timer = setTimeout(() => {
			timer = undefined;
			fn(...args);
		}, delayMs);
	};
}

module.exports = { debounce };
