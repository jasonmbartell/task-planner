/**
 * Platform detection utilities for Tauri vs Browser runtime.
 */

export function isTauri() {
  return typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window;
}
