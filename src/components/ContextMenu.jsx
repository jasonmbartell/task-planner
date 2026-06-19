import { useEffect, useRef } from 'react';

export default function ContextMenu({ x, y, items, onClose }) {
  const ref = useRef(null);

  useEffect(() => {
    const handler = (e) => {
      if (ref.current && !ref.current.contains(e.target)) onClose();
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [onClose]);

  return (
    <div
      ref={ref}
      className="fixed z-[100] py-1 bg-surface-2 border border-accent-amber/20 shadow-xl shadow-black/60 min-w-[160px]"
      style={{ left: x, top: y }}
    >
      {items.map((item, i) =>
        item.separator ? (
          <div key={i} className="border-t border-accent-amber/10 my-1" />
        ) : (
          <button
            key={i}
            onClick={() => { item.action(); onClose(); }}
            className={`w-full text-left px-3 py-1.5 text-xs font-mono hover:bg-accent-amber/10 transition ${
              item.danger ? 'text-accent-red hover:text-accent-red' : 'text-accent-cream/70 hover:text-accent-cream'
            }`}
          >
            {item.label}
          </button>
        )
      )}
    </div>
  );
}
