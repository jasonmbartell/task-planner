import { useState } from 'react';
import { ChevronDown, ChevronRight, Plus, Trash2, Check } from 'lucide-react';
import useStore from '../store/useStore';
import { builtInThemes } from '../themes';

export default function AppearanceSettings() {
  const snippets = useStore((s) => s.customCssConfig?.snippets) || [];
  const addCssSnippet = useStore((s) => s.addCssSnippet);
  const updateCssSnippet = useStore((s) => s.updateCssSnippet);
  const deleteCssSnippet = useStore((s) => s.deleteCssSnippet);

  const [expanded, setExpanded] = useState({});

  const toggleExpand = (id) => setExpanded((e) => ({ ...e, [id]: !e[id] }));

  // Toggle a built-in theme on/off. We persist it as a regular snippet so it
  // shows up in the editor below and can be tweaked or deleted like any other.
  // Re-apply also refreshes `css` in case the bundled theme has been updated
  // since the snippet was first added.
  const toggleBuiltInTheme = (theme) => {
    const existing = snippets.find((s) => s.id === theme.id);
    if (existing) {
      updateCssSnippet(theme.id, { css: theme.css, enabled: !existing.enabled });
    } else {
      addCssSnippet({ id: theme.id, name: theme.name, css: theme.css, enabled: true });
    }
  };

  const isThemeActive = (theme) => {
    const sn = snippets.find((s) => s.id === theme.id);
    return !!(sn && sn.enabled);
  };

  return (
    <div className="p-5 space-y-5 max-w-2xl">
      <div className="flex items-center gap-3 mb-2">
        <div className="w-8 h-8 bg-accent-amber/15 border border-accent-amber/30 flex items-center justify-center">
          <span className="text-accent-amber font-mono font-bold">A</span>
        </div>
        <div>
          <h3 className="text-xs font-semibold text-accent-amber uppercase tracking-[0.2em] font-mono">Appearance</h3>
          <p className="text-[10px] text-accent-cream/30 font-mono">Custom CSS snippets, Obsidian-style</p>
        </div>
      </div>

      {/* ─── Built-in Themes ─── */}
      <div className="space-y-2">
        <h4 className="text-[10px] font-semibold text-accent-amber/70 uppercase tracking-[0.2em] font-mono">Built-in Themes</h4>
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
          {builtInThemes.map((theme) => {
            const active = isThemeActive(theme);
            return (
              <button
                key={theme.id}
                type="button"
                onClick={() => toggleBuiltInTheme(theme)}
                className={`text-left p-3 border transition-all ${
                  active
                    ? 'bg-accent-amber/10 border-accent-amber/40'
                    : 'bg-surface-2 border-accent-amber/15 hover:border-accent-amber/30'
                }`}
              >
                <div className="flex items-center justify-between gap-2 mb-1">
                  <span className={`text-xs font-mono font-medium ${active ? 'text-accent-amber' : 'text-accent-cream/80'}`}>
                    {theme.name}
                  </span>
                  {active && (
                    <span className="flex items-center gap-1 text-[10px] text-accent-amber font-mono uppercase tracking-wider">
                      <Check className="w-3 h-3" /> Active
                    </span>
                  )}
                </div>
                <p className="text-[10px] text-accent-cream/40 font-mono leading-relaxed">{theme.description}</p>
              </button>
            );
          })}
        </div>
      </div>

      <div className="p-3 bg-surface-2/50 border border-accent-amber/10 text-[11px] text-accent-cream/40 font-mono leading-relaxed">
        Snippets (including built-in themes) are appended to the page as <code className="text-accent-amber/70">&lt;style&gt;</code> tags when enabled.
        Tailwind utility classes are low specificity — use <code className="text-accent-amber/70">!important</code> or a high-specificity selector
        (e.g. <code className="text-accent-amber/70">body .surface-1</code>) to override theme styles reliably.
      </div>

      <div className="space-y-2">
        {snippets.length === 0 && (
          <div className="px-3 py-6 text-center text-xs text-accent-cream/25 font-mono border border-dashed border-accent-amber/10">
            No snippets yet. Create one below.
          </div>
        )}
        {snippets.map((sn) => {
          const isExpanded = !!expanded[sn.id];
          return (
            <div key={sn.id} className="border border-accent-amber/15 bg-surface-2">
              <div className="flex items-center gap-2 px-3 py-2">
                <button
                  type="button"
                  onClick={() => toggleExpand(sn.id)}
                  className="text-accent-cream/40 hover:text-accent-amber transition"
                  aria-label={isExpanded ? 'Collapse' : 'Expand'}
                >
                  {isExpanded ? <ChevronDown className="w-3.5 h-3.5" /> : <ChevronRight className="w-3.5 h-3.5" />}
                </button>
                <input
                  value={sn.name}
                  onChange={(e) => updateCssSnippet(sn.id, { name: e.target.value })}
                  placeholder="Snippet name"
                  className="flex-1 bg-transparent text-xs text-accent-cream placeholder-accent-cream/20 font-mono focus:outline-none border-b border-transparent focus:border-accent-amber/30"
                />
                <label className="flex items-center gap-1.5 text-[10px] text-accent-cream/50 font-mono uppercase tracking-wider cursor-pointer">
                  <input
                    type="checkbox"
                    checked={!!sn.enabled}
                    onChange={(e) => updateCssSnippet(sn.id, { enabled: e.target.checked })}
                    className="accent-accent-amber"
                  />
                  {sn.enabled ? 'On' : 'Off'}
                </label>
                <button
                  type="button"
                  onClick={() => {
                    if (confirm(`Delete snippet "${sn.name}"?`)) deleteCssSnippet(sn.id);
                  }}
                  className="p-1 text-accent-cream/30 hover:text-accent-red transition"
                  title="Delete snippet"
                  aria-label="Delete snippet"
                >
                  <Trash2 className="w-3.5 h-3.5" />
                </button>
              </div>
              {isExpanded && (
                <div className="px-3 pb-3">
                  <textarea
                    value={sn.css}
                    onChange={(e) => updateCssSnippet(sn.id, { css: e.target.value })}
                    placeholder="/* Your CSS here */"
                    spellCheck={false}
                    rows={12}
                    className="w-full bg-surface-1 border border-accent-amber/10 px-3 py-2 text-[11px] text-accent-cream placeholder-accent-cream/20 focus:outline-none focus:border-accent-amber/40 font-mono resize-y"
                    style={{ scrollbarWidth: 'thin', scrollbarColor: 'rgba(180,160,100,0.15) transparent' }}
                  />
                </div>
              )}
            </div>
          );
        })}
      </div>

      <button
        type="button"
        onClick={() => {
          const id = `css-${Date.now().toString(36)}`;
          addCssSnippet({ id, name: 'New snippet', css: '', enabled: false });
          setExpanded((e) => ({ ...e, [id]: true }));
        }}
        className="flex items-center gap-2 px-3 py-1.5 text-xs bg-accent-amber/10 border border-accent-amber/20 hover:bg-accent-amber/20 text-accent-amber font-mono font-medium transition-all uppercase tracking-wider"
      >
        <Plus className="w-3.5 h-3.5" />
        New Snippet
      </button>
    </div>
  );
}
