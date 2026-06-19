/**
 * TauriSettings — Desktop-only settings (auto-start, etc.)
 * Only renders when running inside a Tauri native window.
 */
import { useState, useEffect } from 'react';
import { isTauri } from '../utils/platform.js';

export default function TauriSettings() {
  const [autoStart, setAutoStart] = useState(false);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (!isTauri()) {
      setLoading(false);
      return;
    }

    import('@tauri-apps/plugin-autostart').then(({ isEnabled }) => {
      isEnabled().then((enabled) => {
        setAutoStart(enabled);
        setLoading(false);
      });
    }).catch(() => setLoading(false));
  }, []);

  if (!isTauri() || loading) return null;

  const handleToggle = async () => {
    try {
      const { enable, disable } = await import('@tauri-apps/plugin-autostart');
      if (autoStart) {
        await disable();
        setAutoStart(false);
      } else {
        await enable();
        setAutoStart(true);
      }
    } catch (err) {
      console.error('Failed to toggle auto-start:', err);
    }
  };

  return (
    <div className="px-4 py-3 border-t border-accent-amber/10">
      <span className="text-[9px] text-accent-amber/30 uppercase tracking-[0.25em] font-semibold font-mono block mb-2">
        Desktop
      </span>
      <button
        onClick={handleToggle}
        className="flex items-center gap-2 w-full text-left text-[10px] font-mono uppercase tracking-wider text-accent-cream/30 hover:text-accent-cream/60 transition min-h-[44px]"
      >
        <span
          className={`w-6 h-3 rounded-full transition-colors flex-shrink-0 relative ${
            autoStart ? 'bg-accent-amber/60' : 'bg-accent-cream/10'
          }`}
        >
          <span
            className={`absolute top-0.5 w-2 h-2 rounded-full bg-white transition-transform ${
              autoStart ? 'translate-x-3.5' : 'translate-x-0.5'
            }`}
          />
        </span>
        <span>Start on boot</span>
      </button>
    </div>
  );
}
