/**
 * Returns a debounced version of `fn` that delays invocation
 * until `ms` milliseconds have elapsed since the last call.
 */
export function debounce(fn, ms) {
  let timer;
  return (...args) => {
    clearTimeout(timer);
    timer = setTimeout(() => fn(...args), ms);
  };
}
