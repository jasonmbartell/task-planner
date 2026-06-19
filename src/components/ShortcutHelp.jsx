const isMac = typeof navigator !== 'undefined' && /Mac|iPod|iPhone|iPad/.test(navigator.userAgent);
const mod = isMac ? '\u2318' : 'Ctrl';

const SHORTCUTS = [
  { keys: `${mod}+Z`, desc: 'Undo' },
  { keys: `${mod}+Shift+Z`, desc: 'Redo' },
  { keys: 'N', desc: 'New task' },
  { keys: '1', desc: 'Gantt view' },
  { keys: '2', desc: 'Calendar view' },
  { keys: '3', desc: 'Spreadsheet view' },
  { keys: `? / ${mod}+/`, desc: 'Toggle this help' },
  { keys: 'Esc', desc: 'Close modal / overlay' },
];

export default function ShortcutHelp({ onClose }) {
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center" onClick={onClose}>
      <div className="absolute inset-0 bg-black/50" />
      <div
        className="relative bg-surface-1 border border-accent-amber/20 shadow-2xl shadow-black/60 p-6 w-full max-w-sm"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between mb-4">
          <h3 className="text-xs font-semibold text-accent-amber uppercase tracking-[0.2em] font-mono">
            Keyboard Shortcuts
          </h3>
          <button onClick={onClose} className="p-1 hover:bg-accent-amber/10 text-accent-cream/30 hover:text-accent-amber transition font-mono">
            &#x2715;
          </button>
        </div>
        <div className="space-y-1.5">
          {SHORTCUTS.map((s) => (
            <div key={s.keys} className="flex items-center justify-between py-1">
              <span className="text-xs text-accent-cream/60 font-mono">{s.desc}</span>
              <kbd className="text-[10px] bg-surface-2 border border-accent-amber/15 px-2 py-0.5 text-accent-amber/70 font-mono">
                {s.keys}
              </kbd>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
