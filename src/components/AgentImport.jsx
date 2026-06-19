/**
 * AgentImport — Milestone 6 browser fallback UI.
 *
 * Collapsible panel inside the Agent Inbox view. Lets a user paste or drop a
 * JSON bundle of agent ops, preview what each envelope does, run them through
 * `_agentBulkApply`, and download the resulting archive-shaped envelopes.
 *
 * On Tauri, this is *additive*: the file-watcher still handles ops dropped
 * into `agent-inbox/`. The import panel exists so a user who wants to replay
 * a bundle from an LLM conversation has a UI path that doesn't require
 * touching `$APPDATA`.
 *
 * On browser, this is the only agent-op channel (the file watcher is Tauri-only).
 */

import { useCallback, useMemo, useRef, useState } from 'react';
import { Download, FileUp, Play, Trash2, ChevronDown, ChevronRight } from 'lucide-react';
import {
  parseBundleText,
  runBundle,
  buildResultBundleText,
  downloadResultBundle,
  defaultResultFilename,
} from '../agent/importService.js';

const STATUS_CLASS = {
  applied:  'text-accent-green border-accent-green/40 bg-accent-green/5',
  queued:   'text-accent-amber border-accent-amber/40 bg-accent-amber/5',
  rejected: 'text-accent-red border-accent-red/40 bg-accent-red/5',
};

function opSummary(envelope) {
  if (!envelope) return 'unknown';
  if (envelope.type === 'bulk') {
    const n = Array.isArray(envelope.payload?.ops) ? envelope.payload.ops.length : 0;
    return `bulk · ${n} op${n === 1 ? '' : 's'}`;
  }
  return envelope.type || 'unknown';
}

export default function AgentImport({ store, onAfterRun }) {
  const [text, setText] = useState('');
  const [parseError, setParseError] = useState(null);
  const [parsed, setParsed] = useState(null);      // { envelopes, shape }
  const [forceApply, setForceApply] = useState(false);
  const [running, setRunning] = useState(false);
  const [lastRun, setLastRun] = useState(null);    // { results, summary, now }
  const [expanded, setExpanded] = useState(false);
  const [dragOver, setDragOver] = useState(false);
  const fileInputRef = useRef(null);

  const parse = useCallback((rawText) => {
    setParseError(null);
    setLastRun(null);
    const r = parseBundleText(rawText, { now: Date.now() });
    if (!r.ok) {
      setParsed(null);
      setParseError(r.error.message);
      return;
    }
    setParsed({ envelopes: r.envelopes, shape: r.shape });
  }, []);

  const handleTextChange = (e) => {
    const next = e.target.value;
    setText(next);
    if (!next.trim()) {
      setParsed(null);
      setParseError(null);
      setLastRun(null);
    }
  };

  const handleParse = () => parse(text);

  const handleClear = () => {
    setText('');
    setParsed(null);
    setParseError(null);
    setLastRun(null);
  };

  const handleFileChosen = async (file) => {
    if (!file) return;
    try {
      const contents = await file.text();
      setText(contents);
      parse(contents);
    } catch (err) {
      setParseError(`Failed to read file: ${err.message || err}`);
    }
  };

  const handleDrop = async (e) => {
    e.preventDefault();
    setDragOver(false);
    const file = e.dataTransfer?.files?.[0];
    if (file) await handleFileChosen(file);
  };

  const handleRun = async () => {
    if (!parsed) return;
    setRunning(true);
    try {
      const now = Date.now();
      const { results, summary } = runBundle(store, parsed.envelopes, { forceApply, now });
      setLastRun({ results, summary, now });
      if (typeof onAfterRun === 'function') {
        try { onAfterRun({ results, summary }); } catch { /* swallow */ }
      }
    } catch (err) {
      setParseError(`Run failed: ${err.message || err}`);
    } finally {
      setRunning(false);
    }
  };

  const handleDownload = () => {
    if (!lastRun) return;
    const txt = buildResultBundleText(lastRun.results, lastRun.summary, { now: lastRun.now });
    downloadResultBundle(txt, defaultResultFilename(lastRun.now));
  };

  const summaryText = useMemo(() => {
    if (!lastRun) return null;
    const { applied, queued, rejected, total } = lastRun.summary;
    return `${applied}/${total} applied · ${queued} queued · ${rejected} rejected`;
  }, [lastRun]);

  return (
    <div className="border border-accent-amber/15 bg-surface-1">
      <button
        onClick={() => setExpanded((v) => !v)}
        className="w-full flex items-center gap-2 px-3 py-2 text-xs font-mono uppercase tracking-[0.15em] text-accent-amber/80 hover:text-accent-amber"
      >
        {expanded ? <ChevronDown className="w-3 h-3" /> : <ChevronRight className="w-3 h-3" />}
        <FileUp className="w-3 h-3" />
        <span>Import bundle</span>
        <span className="ml-auto text-[10px] text-accent-cream/30 normal-case tracking-normal">
          Paste or drop a JSON bundle of agent ops
        </span>
      </button>

      {expanded && (
        <div className="px-3 pb-3 space-y-3">
          <div
            onDragOver={(e) => { e.preventDefault(); setDragOver(true); }}
            onDragLeave={() => setDragOver(false)}
            onDrop={handleDrop}
            className={`border border-dashed p-2 transition-colors ${dragOver ? 'border-accent-amber/60 bg-accent-amber/5' : 'border-accent-amber/20'}`}
          >
            <textarea
              value={text}
              onChange={handleTextChange}
              placeholder={'{\n  "opId": "op-01...",\n  "type": "task.update",\n  "payload": { "id": "task-abc", "patch": { "status": "done" } }\n}'}
              rows={8}
              spellCheck={false}
              className="w-full bg-surface-0 text-accent-cream/90 text-xs font-mono p-2 outline-none resize-y border border-accent-amber/10 focus:border-accent-amber/30"
            />
            <div className="flex flex-wrap items-center gap-2 mt-2">
              <button
                onClick={handleParse}
                disabled={!text.trim()}
                className="px-2 py-1 text-[10px] font-mono uppercase tracking-wider border border-accent-amber/30 text-accent-amber hover:bg-accent-amber/10 disabled:opacity-40 transition-all"
              >
                Parse
              </button>
              <label className="px-2 py-1 text-[10px] font-mono uppercase tracking-wider border border-accent-cream/20 text-accent-cream/60 hover:text-accent-cream hover:border-accent-cream/40 cursor-pointer transition-all">
                Choose file
                <input
                  ref={fileInputRef}
                  type="file"
                  accept="application/json,.json"
                  className="hidden"
                  onChange={(e) => handleFileChosen(e.target.files?.[0])}
                />
              </label>
              {text && (
                <button
                  onClick={handleClear}
                  className="flex items-center gap-1 px-2 py-1 text-[10px] font-mono uppercase tracking-wider border border-accent-cream/20 text-accent-cream/60 hover:text-accent-cream hover:border-accent-cream/40 transition-all"
                >
                  <Trash2 className="w-3 h-3" /> Clear
                </button>
              )}
            </div>
          </div>

          {parseError && (
            <div className="px-2 py-1.5 text-xs font-mono border border-accent-red/40 text-accent-red bg-accent-red/5">
              {parseError}
            </div>
          )}

          {parsed && (
            <div className="border border-accent-amber/15 bg-surface-2/50">
              <div className="flex items-center justify-between gap-2 px-3 py-2 border-b border-accent-amber/10">
                <div className="text-[10px] font-mono uppercase tracking-wider text-accent-amber/70">
                  Parsed · {parsed.shape} · {parsed.envelopes.length} envelope{parsed.envelopes.length === 1 ? '' : 's'}
                </div>
                <label className="flex items-center gap-1.5 text-[10px] font-mono uppercase tracking-wider text-accent-cream/50 cursor-pointer">
                  <input
                    type="checkbox"
                    checked={forceApply}
                    onChange={(e) => setForceApply(e.target.checked)}
                    className="accent-accent-amber"
                  />
                  forceApply (bypass trust &amp; staleness)
                </label>
                <button
                  onClick={handleRun}
                  disabled={running}
                  className="flex items-center gap-1 px-2 py-1 text-[10px] font-mono uppercase tracking-wider border border-accent-green/40 text-accent-green hover:bg-accent-green/10 disabled:opacity-40 transition-all"
                >
                  <Play className="w-3 h-3" />
                  {running ? 'Running…' : 'Run'}
                </button>
              </div>
              <ul className="px-3 py-2 space-y-1 max-h-40 overflow-auto">
                {parsed.envelopes.map((env, i) => (
                  <li key={env.opId || i} className="flex items-center gap-2 text-[10px] font-mono">
                    <span className="text-accent-cream/40 w-6 text-right">{i + 1}.</span>
                    <span className="text-accent-amber/80 uppercase tracking-wider">{opSummary(env)}</span>
                    <span className="text-accent-cream/40 truncate" title={env.opId}>{env.opId || '<no opId>'}</span>
                  </li>
                ))}
              </ul>
            </div>
          )}

          {lastRun && (
            <div className="border border-accent-amber/15 bg-surface-2/50">
              <div className="flex items-center justify-between gap-2 px-3 py-2 border-b border-accent-amber/10">
                <div className="text-[10px] font-mono uppercase tracking-wider text-accent-amber/70">
                  Run result — {summaryText}
                </div>
                <button
                  onClick={handleDownload}
                  className="flex items-center gap-1 px-2 py-1 text-[10px] font-mono uppercase tracking-wider border border-accent-amber/30 text-accent-amber hover:bg-accent-amber/10 transition-all"
                >
                  <Download className="w-3 h-3" /> Download results
                </button>
              </div>
              <ol className="px-3 py-2 space-y-1 max-h-60 overflow-auto">
                {lastRun.results.map((r, i) => {
                  const status = r.result?.status || 'unknown';
                  return (
                    <li key={r.opId || i} className={`border px-2 py-1.5 text-[10px] font-mono ${STATUS_CLASS[status] || 'border-accent-cream/20 text-accent-cream/60'}`}>
                      <div className="flex items-baseline justify-between gap-2">
                        <span className="uppercase tracking-wider">{status}</span>
                        <span className="text-accent-cream/50 truncate" title={r.opId}>{r.opId || '<no opId>'}</span>
                      </div>
                      <div className="text-accent-cream/50 mt-0.5 truncate">
                        {opSummary(r)}
                      </div>
                      {status === 'queued' && r.result?.reason && (
                        <div className="text-accent-amber/70 mt-0.5">reason: {r.result.reason}</div>
                      )}
                      {status === 'rejected' && r.result?.error && (
                        <div className="text-accent-red/80 mt-0.5 truncate" title={r.result.error.message}>
                          {r.result.error.kind}: {r.result.error.message}
                        </div>
                      )}
                    </li>
                  );
                })}
              </ol>
            </div>
          )}

          <p className="text-[10px] text-accent-cream/25 font-mono">
            Accepted shapes: single envelope · array of envelopes · <code className="text-accent-cream/40">{'{ envelopes: [...] }'}</code> · <code className="text-accent-cream/40">{'{ ops: [...] }'}</code> (wrapped as one bulk envelope).
          </p>
        </div>
      )}
    </div>
  );
}
