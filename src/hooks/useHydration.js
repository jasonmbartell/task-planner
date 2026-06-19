import useStore from '../store/useStore';

/** Returns true once the store has been hydrated from IndexedDB. */
export function useHydration() {
  return useStore((s) => s._hydrated);
}
