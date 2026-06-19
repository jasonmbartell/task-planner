import { RefreshCw } from 'lucide-react';
import useStore from '../store/useStore';

export default function SyncStatus({ onRefresh }) {
  const syncStatus = useStore((s) => s.syncStatus);

  const config = {
    idle: {
      dotClass: 'bg-green-400',
      textClass: 'text-green-400/70',
      label: 'Saved',
      animate: false,
    },
    syncing: {
      dotClass: 'bg-amber-400',
      textClass: 'text-amber-400/70',
      label: 'Syncing...',
      animate: true,
    },
    offline: {
      dotClass: 'bg-accent-cream/30',
      textClass: 'text-accent-cream/40',
      label: 'Offline',
      animate: false,
    },
    error: {
      dotClass: 'bg-red-400',
      textClass: 'text-red-400/70',
      label: 'Sync error',
      animate: false,
    },
  };

  const c = config[syncStatus] || config.idle;
  const isSyncing = syncStatus === 'syncing';

  return (
    <div className={`flex items-center gap-1 text-xs font-mono tracking-wider uppercase ${c.textClass}`}>
      <span className={`w-1.5 h-1.5 rounded-full ${c.dotClass} ${c.animate ? 'animate-pulse' : ''}`} />
      <span className="hidden md:inline">{c.label}</span>
      {onRefresh && (
        <button
          type="button"
          onClick={onRefresh}
          disabled={isSyncing}
          className="min-w-[44px] min-h-[44px] flex items-center justify-center text-accent-cream/30 hover:text-accent-cream/60 disabled:opacity-40 transition-colors"
          aria-label="Refresh sync"
        >
          <RefreshCw className={`w-3.5 h-3.5 ${isSyncing ? 'animate-spin' : ''}`} />
        </button>
      )}
    </div>
  );
}
