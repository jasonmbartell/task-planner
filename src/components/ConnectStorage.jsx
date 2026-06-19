import { Cloud, CloudOff, Loader2 } from 'lucide-react';
import useStore from '../store/useStore';

export default function ConnectStorage({ connectGoogle, connectMicrosoft, disconnect }) {
  const cloudProvider = useStore((s) => s.cloudProvider);
  const cloudVerified = useStore((s) => s.cloudVerified);
  // Hold "Verifying…" until the first cloud round-trip succeeds — otherwise
  // the badge briefly paints a confident green over a refresh token that may
  // turn out to be revoked. Once useSync sees AuthExpiredError it clears
  // cloudProvider entirely and the user falls through to the Connect button.
  const googleConnected = cloudProvider === 'google' && cloudVerified;
  const googleVerifying = cloudProvider === 'google' && !cloudVerified;
  const microsoftConnected = cloudProvider === 'microsoft' && cloudVerified;

  return (
    <div className="p-5 space-y-5 max-w-lg">
      {/* Header */}
      <div className="flex items-center gap-3 mb-6">
        <div className="w-8 h-8 bg-accent-amber/15 border border-accent-amber/30 flex items-center justify-center">
          <Cloud className="w-4 h-4 text-accent-amber" />
        </div>
        <div>
          <h3 className="text-xs font-semibold text-accent-amber uppercase tracking-[0.2em] font-mono">Cloud Storage</h3>
          <p className="text-[10px] text-accent-cream/30 font-mono">
            Your data is always saved locally. Connect cloud storage to sync across devices.
          </p>
        </div>
      </div>

        <div className="space-y-4">
          {/* Google Drive */}
          <div className={`p-3 border space-y-3 ${
            googleConnected ? 'bg-green-400/5 border-green-400/20' :
            googleVerifying ? 'bg-amber-400/5 border-amber-400/20' :
            'bg-surface-1 border-accent-amber/10'
          }`}>
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-2">
                {googleConnected ? (
                  <Cloud className="w-4 h-4 text-green-400" />
                ) : googleVerifying ? (
                  <Loader2 className="w-4 h-4 text-amber-400 animate-spin" />
                ) : (
                  <CloudOff className="w-4 h-4 text-accent-cream/30" />
                )}
                <span className="text-xs text-accent-cream/70 font-mono uppercase tracking-wider">Google Drive</span>
              </div>
              {googleConnected ? (
                <div className="flex items-center gap-2">
                  <span className="flex items-center gap-1.5 text-[10px] text-green-400 font-mono uppercase tracking-wider">
                    <span className="w-1.5 h-1.5 rounded-full bg-green-400" />
                    Connected
                  </span>
                  <button
                    onClick={() => disconnect('google')}
                    className="px-3 py-1.5 text-xs bg-red-400/10 border border-red-400/20 hover:bg-red-400/20 text-red-400/70 font-mono font-medium transition-all uppercase tracking-wider"
                  >
                    Disconnect
                  </button>
                </div>
              ) : googleVerifying ? (
                <span className="flex items-center gap-1.5 text-[10px] text-amber-400 font-mono uppercase tracking-wider">
                  <span className="w-1.5 h-1.5 rounded-full bg-amber-400 animate-pulse" />
                  Verifying…
                </span>
              ) : (
                <button
                  onClick={connectGoogle}
                  className="px-3 py-1.5 text-xs bg-accent-amber/10 border border-accent-amber/20 hover:bg-accent-amber/20 text-accent-amber font-mono font-medium transition-all uppercase tracking-wider"
                >
                  Connect Google Drive
                </button>
              )}
            </div>
            {googleConnected && (
              <p className="text-[10px] text-green-400/50 font-mono leading-relaxed">
                Syncing to your Google Drive appDataFolder. Changes save automatically.
              </p>
            )}
            {googleVerifying && (
              <p className="text-[10px] text-amber-400/60 font-mono leading-relaxed">
                Checking your Google Drive credentials… If they've been revoked you'll be asked to reconnect.
              </p>
            )}
          </div>

          {/* OneDrive — disabled, not yet configured */}
          <div className="p-3 bg-surface-1 border border-accent-cream/5 space-y-3 opacity-40">
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-2">
                <CloudOff className="w-4 h-4 text-accent-cream/20" />
                <span className="text-xs text-accent-cream/40 font-mono uppercase tracking-wider">OneDrive</span>
              </div>
              <span className="px-3 py-1.5 text-[10px] text-accent-cream/30 font-mono uppercase tracking-wider border border-accent-cream/10">
                Coming Soon
              </span>
            </div>
            <p className="text-[10px] text-accent-cream/20 font-mono leading-relaxed">
              OneDrive sync requires an Azure AD app registration. Setup instructions in the README.
            </p>
          </div>
        </div>

      {/* Info box */}
      <div className="mt-4 p-3 bg-surface-2/50 border border-accent-amber/10">
        <h4 className="text-[10px] font-semibold text-accent-amber/30 uppercase tracking-[0.2em] mb-2 font-mono">How it works</h4>
        <p className="text-[10px] text-accent-cream/30 font-mono leading-relaxed">
          When connected, your tasks, projects, and sprints are automatically synced to your cloud storage.
          Changes sync in the background so your data is always up to date across devices.
        </p>
      </div>
    </div>
  );
}
