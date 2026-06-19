/**
 * IngestModal — in-app entry for the prose / markdown → tasks ingestion feature.
 *
 * UX:
 *   1. Paste prose / a properly-formatted markdown task file / a brain-dump
 *      into the textarea (or drop / upload .xlsx, .csv, .md, .txt).
 *   2. Pick a shape radio:
 *        - Auto (default)  — run detectInputShape, pick markdown vs prose.
 *        - Prose           — force LLM extraction.
 *        - Markdown        — run the deterministic parser (re-import of .md).
 *   3. Press Extract → orchestrator call → editable candidate list renders.
 *   4. Approve / reject candidates, edit titles, press Apply →
 *      single bulk envelope through _agentBulkApply with forceApply: true.
 *
 * The inline Settings disclosure exposes the LLM config (API key, endpoint,
 * model), the confidence threshold, and the last-ingestion diagnostics —
 * the pieces that used to live in the standalone Obsidian Settings page.
 *
 * All non-UI logic lives in `src/ingest/proseIngest.js` so this component is
 * a thin shell. Run results (# added, errors) surface as an inline banner.
 */

import { useCallback, useMemo, useRef, useState } from 'react';
import {
  Sparkles,
  Check,
  X,
  Play,
  Loader2,
  AlertTriangle,
  Settings,
  Upload,
  FileSpreadsheet,
  ChevronDown,
  ChevronRight,
} from 'lucide-react';
import {
  runProseExtraction,
  buildIngestEnvelope,
  applyIngestEnvelope,
  buildLLMClientFromConfig,
  ProseIngestionNoLlmError,
} from '../ingest/proseIngest.js';
import { detectInputShape } from '../obsidian/parseOrchestrator.js';
import { spreadsheetToMarkdown } from '../obsidian/spreadsheetToMarkdown.js';
import { estimateExtractionCost, formatCostLine } from '../ingest/costEstimate.js';

const MARKDOWN_EXTS = new Set(['md', 'markdown']);

const SPREADSHEET_EXTS = ['xlsx', 'xls', 'xlsm', 'csv', 'tsv'];
const TEXT_EXTS = ['md', 'markdown', 'txt'];

function fileExt(name) {
  if (typeof name !== 'string') return '';
  const dot = name.lastIndexOf('.');
  return dot < 0 ? '' : name.slice(dot + 1).toLowerCase();
}

const SHAPE_OPTIONS = [
  { value: 'auto',     label: 'Auto', hint: 'Detect markdown markers vs. prose.' },
  { value: 'prose',    label: 'Prose', hint: 'Force LLM extraction.' },
  { value: 'markdown', label: 'Markdown', hint: 'Parse a properly-formatted markdown task file.' },
];

function formatConfidence(c) {
  if (typeof c !== 'number' || Number.isNaN(c)) return null;
  return `${Math.round(c * 100)}%`;
}

function ShapeRadio({ value, onChange, disabled }) {
  return (
    <div className="flex flex-wrap gap-2" role="radiogroup" aria-label="Input shape">
      {SHAPE_OPTIONS.map((opt) => (
        <label
          key={opt.value}
          className={`flex items-center gap-2 px-2 py-1 text-[10px] font-mono uppercase tracking-wider border cursor-pointer transition-all ${
            value === opt.value
              ? 'border-accent-amber/60 text-accent-amber bg-accent-amber/10'
              : 'border-accent-cream/15 text-accent-cream/50 hover:border-accent-cream/30 hover:text-accent-cream/80'
          } ${disabled ? 'opacity-40 pointer-events-none' : ''}`}
          title={opt.hint}
        >
          <input
            type="radio"
            name="ingest-shape"
            value={opt.value}
            checked={value === opt.value}
            onChange={() => onChange(opt.value)}
            className="accent-accent-amber"
          />
          {opt.label}
        </label>
      ))}
    </div>
  );
}

function CandidateRow({ candidate, index, accepted, onToggle, onTitleEdit, onDescriptionEdit, showSource, lowConfidence, isDuplicate }) {
  const [expanded, setExpanded] = useState(false);
  const confPct = formatConfidence(candidate._confidence);
  const srcRaw = candidate._sourcePointer?.rawText || '';

  // Border tint priorities: duplicate > accepted > low-confidence warning > unaccepted
  const borderClass = isDuplicate
    ? 'border-accent-red/40 bg-accent-red/5'
    : accepted
      ? (lowConfidence ? 'border-accent-amber/40 bg-accent-amber/5' : 'border-accent-green/30 bg-accent-green/5')
      : 'border-accent-cream/10 bg-surface-2/40 opacity-60';

  return (
    <li
      className={`border p-2 transition-colors ${borderClass}`}
    >
      <div className="flex items-start gap-2">
        {isDuplicate ? (
          <span
            className="mt-1 inline-flex items-center justify-center w-3 h-3 text-accent-red"
            title="A task with this title already exists — edit the title to apply this candidate"
            aria-label={`Duplicate: "${candidate.title}" already exists`}
          >
            <X className="w-3 h-3" strokeWidth={3} />
          </span>
        ) : (
          <input
            type="checkbox"
            checked={accepted}
            onChange={onToggle}
            className="mt-1 accent-accent-green"
            aria-label={`Accept "${candidate.title}"`}
          />
        )}
        <div className="flex-1 min-w-0 space-y-1">
          <input
            type="text"
            value={candidate.title}
            onChange={(e) => onTitleEdit(e.target.value)}
            className={`w-full bg-transparent text-sm border-b focus:border-accent-amber/40 outline-none font-mono py-0.5 ${
              isDuplicate
                ? 'text-accent-red border-accent-red/20'
                : 'text-accent-cream/90 border-accent-cream/10'
            }`}
            spellCheck={false}
          />
          <div className="flex flex-wrap gap-2 text-[10px] font-mono text-accent-cream/40 uppercase tracking-wider">
            {isDuplicate && (
              <span
                className="text-accent-red/90"
                title="A task with this title already exists in the planner — edit the title to apply this candidate"
              >
                task exists
              </span>
            )}
            {confPct && (
              <span
                className={lowConfidence ? 'text-accent-amber/80' : ''}
                title={lowConfidence ? 'Below confidence threshold — review before applying' : "Model's self-reported confidence"}
              >
                {lowConfidence && <AlertTriangle className="w-2.5 h-2.5 inline mr-0.5 -mt-px" />}
                conf: {confPct}
              </span>
            )}
            {candidate.dueDate && <span>due: {candidate.dueDate}</span>}
            {candidate.urgency != null && <span>urg: {candidate.urgency}</span>}
            {candidate.importance != null && <span>imp: {candidate.importance}</span>}
            {candidate.difficulty != null && <span>diff: {candidate.difficulty}</span>}
            {candidate.status && candidate.status !== 'todo' && <span>status: {candidate.status}</span>}
          </div>
          {(candidate.description || showSource) && (
            <details
              open={expanded}
              onToggle={(e) => setExpanded(e.currentTarget.open)}
              className="text-[10px] font-mono text-accent-cream/50"
            >
              <summary className="cursor-pointer hover:text-accent-cream/80 select-none">
                {expanded ? 'hide details' : 'details'}
              </summary>
              <textarea
                value={candidate.description || ''}
                onChange={(e) => onDescriptionEdit(e.target.value)}
                rows={3}
                placeholder="description (optional)"
                className="w-full mt-1 bg-surface-0 text-accent-cream/80 p-1.5 text-[11px] outline-none border border-accent-cream/10 focus:border-accent-amber/30 resize-y"
                spellCheck={false}
              />
              {showSource && srcRaw && (
                <div className="mt-1 p-1.5 bg-surface-0 border border-accent-cream/5 text-accent-cream/50 whitespace-pre-wrap break-words max-h-32 overflow-auto">
                  <div className="text-[9px] uppercase tracking-[0.2em] text-accent-cream/30 mb-1">
                    source{candidate._sourcePointer?.source ? ` · ${candidate._sourcePointer.source}` : ''}
                  </div>
                  {srcRaw}
                </div>
              )}
            </details>
          )}
        </div>
        <span className="text-[10px] font-mono text-accent-cream/20 select-none">#{index + 1}</span>
      </div>
    </li>
  );
}

export default function IngestModal({ onClose, store }) {
  const [text, setText] = useState('');
  const [shape, setShape] = useState('auto');
  const [extracting, setExtracting] = useState(false);
  const [extractError, setExtractError] = useState(null);
  const [extraction, setExtraction] = useState(null);  // { projectName, projectDescription, tasks }
  const [candidates, setCandidates] = useState([]);    // [{ id, title, description, ..., _accepted }]
  const [projectNameOverride, setProjectNameOverride] = useState('');
  const [applyResult, setApplyResult] = useState(null);
  const [applying, setApplying] = useState(false);
  const [sourceLabel, setSourceLabel] = useState('pasted-text');
  const [dragActive, setDragActive] = useState(false);
  const [loadingFile, setLoadingFile] = useState(false);
  // Snapshot of existing task titles (lowercased + trimmed) at extract time,
  // used to flag candidates whose title already exists in the planner so the
  // user sees a red X and "task exists" tag instead of green-accepted styling.
  const [existingTitles, setExistingTitles] = useState(() => new Set());
  const fileInputRef = useRef(null);

  // Snapshot the relevant config slice once. Reading via getState() (vs. a
  // store hook) is fine here — the modal owns its own input fields and writes
  // back through setObsidianConfig, so nothing else needs to subscribe.
  const initialConfig = store?.getState()?.obsidianConfig || {};
  const [llmApiKey, setLlmApiKey] = useState(initialConfig.llmApiKey || '');
  const [llmEndpointUrl, setLlmEndpointUrl] = useState(initialConfig.llmEndpointUrl || '');
  const [llmModelInput, setLlmModelInput] = useState(initialConfig.llmModel || 'claude-sonnet-4-20250514');
  const [threshold, setThreshold] = useState(
    typeof initialConfig.ingestConfidenceThreshold === 'number' ? initialConfig.ingestConfidenceThreshold : 0.5,
  );
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [advancedOpen, setAdvancedOpen] = useState(false);
  const [testingLLM, setTestingLLM] = useState(false);
  const [llmTestResult, setLlmTestResult] = useState(null);
  const lastIngestion = initialConfig.lastIngestion || null;

  const persistConfig = useCallback((patch) => {
    if (!store?.getState) return;
    const fn = store.getState().setObsidianConfig;
    if (typeof fn === 'function') fn(patch);
  }, [store]);

  const llmClient = useMemo(() => {
    if (!llmApiKey.trim()) return null;
    return buildLLMClientFromConfig({
      llmApiKey,
      llmEndpointUrl,
      llmModel: llmModelInput,
    });
  }, [llmApiKey, llmEndpointUrl, llmModelInput]);

  const llmModel = llmModelInput || 'claude-sonnet-4-20250514';

  const costEstimate = useMemo(() => {
    if (!text.trim()) return null;
    return estimateExtractionCost(text, llmModel);
  }, [text, llmModel]);

  const resolvedProjectName = useMemo(() => {
    if (projectNameOverride.trim()) return projectNameOverride.trim();
    return extraction?.projectName || 'Inbox';
  }, [extraction, projectNameOverride]);

  const acceptedCount = useMemo(
    () => candidates.reduce((n, c) => n + (c._accepted ? 1 : 0), 0),
    [candidates],
  );

  const handleExtract = useCallback(async () => {
    setExtractError(null);
    setApplyResult(null);
    setExtraction(null);
    setCandidates([]);

    const trimmed = text.trim();
    if (!trimmed) {
      setExtractError('Paste or type some text first.');
      return;
    }

    // Format check: when the user explicitly picks "Markdown", make sure
    // the content actually carries markdown task markers. Without this the
    // deterministic parser silently returns 0 tasks and the user sees a
    // generic "no tasks" error with no clue about why.
    if (shape === 'markdown' && detectInputShape(trimmed) !== 'markdown') {
      setExtractError(
        'No markdown task markers found. Markdown mode expects lines like `- [ ] Task title`, ' +
        'a `## Task:` block, or a pipe-delimited table. Switch to Prose or Auto for unstructured text.',
      );
      return;
    }

    setExtracting(true);
    try {
      const existingTasks = store?.getState()?.tasks ?? [];
      const titleSet = new Set(
        existingTasks
          .map((t) => String(t?.title || '').trim().toLowerCase())
          .filter(Boolean),
      );
      setExistingTitles(titleSet);
      const result = await runProseExtraction(trimmed, {
        inputShape: shape,
        llmClient,
        sourceLabel,
        existingTasks,
      });
      setExtraction(result);
      // Auto-uncheck candidates whose self-reported confidence is below the
      // current threshold (M-P6). Candidates without a confidence value
      // (structured path) accept by default. Title-duplicates are also forced
      // to unaccepted so re-ingesting the same prose can't silently double up.
      setCandidates(result.tasks.map((t) => {
        const c = typeof t._confidence === 'number' ? t._confidence : 1;
        const isDup = titleSet.has(String(t.title || '').trim().toLowerCase());
        return { ...t, _accepted: !isDup && c >= threshold };
      }));
      if (!result.tasks.length) {
        setExtractError('Extraction produced no tasks. Try a different shape or reword the input.');
      }
    } catch (err) {
      if (err instanceof ProseIngestionNoLlmError) {
        setExtractError(err.message);
      } else {
        setExtractError(`Extraction failed: ${err.message || err}`);
      }
    } finally {
      setExtracting(false);
    }
  }, [text, shape, llmClient, store, sourceLabel, threshold]);

  const updateThreshold = useCallback((next) => {
    const clamped = Math.min(1, Math.max(0, Number(next) || 0));
    setThreshold(clamped);
    persistConfig({ ingestConfidenceThreshold: clamped });
  }, [persistConfig]);

  const handleApiKeyChange = useCallback((value) => {
    setLlmApiKey(value);
    persistConfig({ llmApiKey: value });
    setLlmTestResult(null);
  }, [persistConfig]);

  const handleEndpointChange = useCallback((value) => {
    setLlmEndpointUrl(value);
    persistConfig({ llmEndpointUrl: value });
  }, [persistConfig]);

  const handleModelChange = useCallback((value) => {
    setLlmModelInput(value);
    persistConfig({ llmModel: value });
  }, [persistConfig]);

  const handleTestLLM = useCallback(async () => {
    if (!llmApiKey.trim()) return;
    setTestingLLM(true);
    setLlmTestResult(null);
    try {
      const { LLMClient } = await import('../obsidian/llmClient.js');
      const client = new LLMClient({
        apiKey: llmApiKey,
        endpointUrl: llmEndpointUrl || undefined,
        model: llmModelInput || undefined,
      });
      const ok = await client.testConnection();
      setLlmTestResult(ok ? 'success' : 'failed: unexpected response');
    } catch (err) {
      setLlmTestResult(`failed: ${err.message || err}`);
    } finally {
      setTestingLLM(false);
    }
  }, [llmApiKey, llmEndpointUrl, llmModelInput]);

  const handleFile = useCallback(async (file) => {
    if (!file) return;
    setExtractError(null);
    setApplyResult(null);

    const ext = fileExt(file.name);
    if (SPREADSHEET_EXTS.includes(ext)) {
      setLoadingFile(true);
      try {
        const result = await spreadsheetToMarkdown(file, { fileName: file.name });
        setText(result.markdown);
        setShape('prose');
        setSourceLabel(file.name);
        setExtraction(null);
        setCandidates([]);
      } catch (err) {
        setExtractError(err.message || String(err));
      } finally {
        setLoadingFile(false);
      }
      return;
    }

    if (TEXT_EXTS.includes(ext) || ext === '') {
      // Type check: in explicit "Markdown" mode, only accept .md/.markdown.
      // .txt files often contain prose; loading them as markdown silently
      // yields 0 tasks. Hint the user to switch modes instead.
      if (shape === 'markdown' && !MARKDOWN_EXTS.has(ext)) {
        setExtractError(
          `Markdown mode expects a .md or .markdown file (got .${ext || 'no-extension'}). ` +
          'Switch the shape to Prose or Auto for plain-text files.',
        );
        return;
      }
      setLoadingFile(true);
      try {
        const txt = await file.text();
        setText(txt);
        setSourceLabel(file.name);
        setExtraction(null);
        setCandidates([]);
      } catch (err) {
        setExtractError(`Unable to read file: ${err.message || err}`);
      } finally {
        setLoadingFile(false);
      }
      return;
    }

    setExtractError(`Unsupported file type: .${ext}. Use .xlsx / .csv / .md / .txt.`);
  }, [shape]);

  const onDrop = useCallback((e) => {
    e.preventDefault();
    e.stopPropagation();
    setDragActive(false);
    const file = e.dataTransfer?.files?.[0];
    if (file) handleFile(file);
  }, [handleFile]);

  const onDragOver = useCallback((e) => {
    e.preventDefault();
    e.stopPropagation();
    if (!dragActive) setDragActive(true);
  }, [dragActive]);

  const onDragLeave = useCallback((e) => {
    e.preventDefault();
    e.stopPropagation();
    setDragActive(false);
  }, []);

  const handleApply = useCallback(async () => {
    setApplyResult(null);
    const accepted = candidates.filter((c) => c._accepted);
    if (accepted.length === 0) {
      setApplyResult({ tone: 'err', text: 'No candidates accepted. Check at least one row or close the modal.' });
      return;
    }
    if (!store) {
      setApplyResult({ tone: 'err', text: 'No store — this modal was opened outside the app.' });
      return;
    }

    setApplying(true);
    try {
      const state = store.getState();
      const { envelope, droppedDeps } = buildIngestEnvelope(accepted, {
        projectName: resolvedProjectName,
        projectDescription: extraction?.projectDescription || '',
        existingProjects: state.projects,
        existingSprints: state.sprints,
        existingTasks: state.tasks,
      });
      const res = applyIngestEnvelope(store, envelope);
      if (res.status === 'applied') {
        const dropNote = droppedDeps.length > 0
          ? ` Dropped ${droppedDeps.length} unresolvable dep ref${droppedDeps.length === 1 ? '' : 's'} (target not in paste or store).`
          : '';
        setApplyResult({
          tone: droppedDeps.length > 0 ? 'warn' : 'ok',
          text: `Applied ${accepted.length} task${accepted.length === 1 ? '' : 's'} to "${resolvedProjectName}" / Inbox.${dropNote}`,
        });
        // Telemetry for the diagnostics panel (M-P6).
        const recordIngestion = state.recordIngestion;
        if (typeof recordIngestion === 'function') {
          recordIngestion({
            at: Date.now(),
            source: sourceLabel,
            model: extraction?._extraction?.model || llmModel,
            candidateCount: candidates.length,
            accepted: accepted.length,
            costUsd: costEstimate?.costUsd ?? 0,
            tokensUsed: extraction?._extraction?.tokensUsed ?? null,
            projectName: resolvedProjectName,
            droppedDeps: droppedDeps.length,
          });
        }
        // Drop the applied candidates so re-apply is a deliberate, fresh action.
        setCandidates([]);
        setExtraction(null);
        setText('');
      } else if (res.status === 'queued') {
        setApplyResult({ tone: 'warn', text: `Queued for review: ${res.reason || 'unknown reason'}. Check the Agent Inbox.` });
      } else {
        setApplyResult({ tone: 'err', text: `Rejected: ${res.error?.message || res.error?.kind || 'unknown'}` });
      }
    } catch (err) {
      setApplyResult({ tone: 'err', text: `Apply failed: ${err.message || err}` });
    } finally {
      setApplying(false);
    }
  }, [candidates, store, resolvedProjectName, extraction, sourceLabel, llmModel, costEstimate]);

  const proseNeedsLLM = (shape === 'prose' || shape === 'auto') && !llmClient;
  const showSourceUI = (extraction?.tasks || []).some((t) => t._sourcePointer?.rawText);

  return (
    <div className="fixed inset-0 z-[60] flex items-center justify-center bg-black/60 p-4" role="dialog" aria-label="Ingest tasks">
      <div className="w-full max-w-3xl max-h-[90vh] flex flex-col bg-surface-1 border border-accent-amber/30 shadow-xl shadow-black/60">
        <div className="flex items-center justify-between px-4 py-3 border-b border-accent-amber/10">
          <div className="flex items-center gap-2">
            <Sparkles className="w-4 h-4 text-accent-amber" />
            <h3 className="text-xs font-mono uppercase tracking-[0.2em] text-accent-amber">Ingest tasks from text</h3>
          </div>
          <button
            onClick={onClose}
            className="text-accent-cream/50 hover:text-accent-cream"
            aria-label="Close ingest modal"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        <div className="flex-1 overflow-auto p-4 space-y-4">
          {/* Shape + LLM status */}
          <div className="flex items-center gap-3 flex-wrap">
            <ShapeRadio
              value={shape}
              onChange={(next) => {
                // Markdown mode is file-only — drop any pasted prose so the
                // user isn't left with stale content they can't see or edit
                // in the file-picker UI.
                if (next === 'markdown' && sourceLabel === 'pasted-text' && text) {
                  setText('');
                  setExtraction(null);
                  setCandidates([]);
                  setExtractError(null);
                }
                setShape(next);
              }}
              disabled={extracting}
            />
            <button
              type="button"
              onClick={() => setSettingsOpen((v) => !v)}
              className={`flex items-center gap-1 px-2 py-1 text-[10px] font-mono uppercase tracking-wider border transition-all ${
                proseNeedsLLM
                  ? 'border-accent-red/40 text-accent-red hover:bg-accent-red/10'
                  : 'border-accent-cream/20 text-accent-cream/60 hover:text-accent-cream hover:border-accent-cream/40'
              }`}
              title={proseNeedsLLM ? 'Prose extraction needs an LLM API key' : 'LLM + ingestion settings'}
              aria-expanded={settingsOpen}
            >
              <Settings className="w-3 h-3" />
              {proseNeedsLLM ? 'Configure LLM' : 'Settings'}
            </button>
          </div>

          {/* Inline settings — replaces the standalone Obsidian Settings page. */}
          {settingsOpen && (
            <div className="p-3 bg-surface-2/40 border border-accent-amber/15 space-y-3">
              <h4 className="text-[10px] font-semibold text-accent-amber/40 uppercase tracking-[0.2em] font-mono">
                Ingestion settings
              </h4>
              <p className="text-[9px] text-accent-cream/30 font-mono">
                Prose extraction calls an LLM. Without an API key, prose mode disables itself and the deterministic markdown parser still works for properly-formatted .md files.
              </p>

              <div className="space-y-1">
                <label className="text-[10px] font-semibold text-accent-amber/40 uppercase tracking-[0.2em] font-mono">
                  API Key
                </label>
                <div className="flex gap-2">
                  <input
                    type="password"
                    value={llmApiKey}
                    onChange={(e) => handleApiKeyChange(e.target.value)}
                    placeholder="sk-ant-..."
                    className="flex-1 bg-surface-2 border border-accent-amber/15 px-3 py-1.5 text-xs text-accent-cream placeholder-accent-cream/20 focus:outline-none focus:border-accent-amber/40 font-mono"
                  />
                  <button
                    type="button"
                    onClick={handleTestLLM}
                    disabled={!llmApiKey.trim() || testingLLM}
                    className="px-2 py-1.5 text-[10px] bg-accent-amber/10 border border-accent-amber/20 hover:bg-accent-amber/20 text-accent-amber font-mono uppercase tracking-wider transition-all disabled:opacity-40"
                  >
                    {testingLLM ? '...' : 'Test'}
                  </button>
                </div>
                {llmTestResult && (
                  <p className={`text-[10px] font-mono ${llmTestResult === 'success' ? 'text-accent-green' : 'text-accent-red'}`}>
                    {llmTestResult === 'success' ? 'Connection successful' : llmTestResult}
                  </p>
                )}
              </div>

              <button
                type="button"
                onClick={() => setAdvancedOpen((v) => !v)}
                className="flex items-center gap-1 text-[10px] text-accent-cream/40 hover:text-accent-cream/70 font-mono uppercase tracking-wider"
                aria-expanded={advancedOpen}
              >
                {advancedOpen ? <ChevronDown className="w-2.5 h-2.5" /> : <ChevronRight className="w-2.5 h-2.5" />}
                Advanced
              </button>

              {advancedOpen && (
                <div className="space-y-3 pl-2 border-l border-accent-amber/15">
                  <div className="space-y-1">
                    <label className="text-[10px] font-semibold text-accent-amber/40 uppercase tracking-[0.2em] font-mono">
                      Endpoint URL
                    </label>
                    <input
                      value={llmEndpointUrl}
                      onChange={(e) => handleEndpointChange(e.target.value)}
                      placeholder="https://api.anthropic.com/v1/messages"
                      className="w-full bg-surface-2 border border-accent-amber/15 px-3 py-1.5 text-xs text-accent-cream placeholder-accent-cream/20 focus:outline-none focus:border-accent-amber/40 font-mono"
                    />
                    <p className="text-[9px] text-accent-cream/20 font-mono">
                      Leave empty for Anthropic API. Set to use Ollama, LM Studio, or other OpenAI-compatible endpoints.
                    </p>
                  </div>

                  <div className="space-y-1">
                    <label className="text-[10px] font-semibold text-accent-amber/40 uppercase tracking-[0.2em] font-mono">
                      Model
                    </label>
                    <input
                      value={llmModelInput}
                      onChange={(e) => handleModelChange(e.target.value)}
                      placeholder="claude-sonnet-4-20250514"
                      className="w-full bg-surface-2 border border-accent-amber/15 px-3 py-1.5 text-xs text-accent-cream placeholder-accent-cream/20 focus:outline-none focus:border-accent-amber/40 font-mono"
                    />
                  </div>

                  <div className="space-y-1">
                    <label className="text-[10px] font-semibold text-accent-amber/40 uppercase tracking-[0.2em] font-mono">
                      Confidence threshold
                    </label>
                    <div className="flex items-center gap-2">
                      <input
                        type="range"
                        min={0}
                        max={1}
                        step={0.05}
                        value={threshold}
                        onChange={(e) => updateThreshold(e.target.value)}
                        className="accent-accent-amber flex-1"
                        aria-label="Default confidence threshold for prose ingestion"
                      />
                      <span className="text-[10px] font-mono text-accent-amber/80 tabular-nums w-10 text-right">
                        {Math.round(threshold * 100)}%
                      </span>
                    </div>
                    <p className="text-[9px] text-accent-cream/20 font-mono">
                      Candidates from prose ingestion below this confidence start unchecked in the review list.
                    </p>
                  </div>
                </div>
              )}

              {lastIngestion && (
                <div className="mt-2 p-2.5 bg-surface-2/30 border border-accent-amber/10 text-[10px] font-mono text-accent-cream/50 space-y-0.5">
                  <div className="text-[9px] uppercase tracking-[0.2em] text-accent-amber/50 mb-1">
                    Last ingestion
                  </div>
                  <div>
                    {lastIngestion.accepted}/{lastIngestion.candidateCount} task
                    {lastIngestion.candidateCount === 1 ? '' : 's'}
                    {' '}from{' '}
                    <span className="text-accent-cream/80">{lastIngestion.source || 'pasted-text'}</span>
                    {' '}→{' '}
                    <span className="text-accent-cream/80">{lastIngestion.projectName || 'Inbox'}</span>
                  </div>
                  <div className="text-accent-cream/30">
                    {lastIngestion.model ? `${lastIngestion.model} · ` : ''}
                    {lastIngestion.tokensUsed != null ? `${lastIngestion.tokensUsed.toLocaleString()} tok · ` : ''}
                    {typeof lastIngestion.costUsd === 'number'
                      ? (lastIngestion.costUsd === 0
                          ? 'free'
                          : lastIngestion.costUsd < 0.01
                            ? '<$0.01'
                            : `~$${lastIngestion.costUsd.toFixed(2)}`)
                      : ''}
                    {lastIngestion.droppedDeps > 0
                      ? ` · dropped ${lastIngestion.droppedDeps} dep ref${lastIngestion.droppedDeps === 1 ? '' : 's'}`
                      : ''}
                  </div>
                  <div className="text-accent-cream/20 text-[9px]">
                    {lastIngestion.at ? new Date(lastIngestion.at).toLocaleString() : ''}
                  </div>
                </div>
              )}
            </div>
          )}

          {/* Input zone — paste/drop textarea for prose & auto, file-only
              picker for markdown (typing arbitrary text in markdown mode
              defeats the deterministic-parse contract). */}
          {shape === 'markdown' ? (
            <div
              onDrop={onDrop}
              onDragOver={onDragOver}
              onDragEnter={onDragOver}
              onDragLeave={onDragLeave}
              onClick={() => !extracting && !loadingFile && fileInputRef.current?.click()}
              role="button"
              tabIndex={0}
              onKeyDown={(e) => {
                if ((e.key === 'Enter' || e.key === ' ') && !extracting && !loadingFile) {
                  e.preventDefault();
                  fileInputRef.current?.click();
                }
              }}
              className={`relative border min-h-[10rem] flex items-center justify-center cursor-pointer ${
                dragActive ? 'border-accent-amber/60 bg-accent-amber/5' : 'border-accent-amber/10 hover:border-accent-amber/30'
              } transition-colors`}
              aria-label="Markdown file picker"
            >
              {loadingFile ? (
                <span className="flex items-center text-accent-amber font-mono text-xs uppercase tracking-[0.2em]">
                  <Loader2 className="w-3.5 h-3.5 animate-spin mr-2" /> Reading file…
                </span>
              ) : sourceLabel && sourceLabel !== 'pasted-text' && text ? (
                <div className="flex flex-col items-center gap-1 px-3 text-center">
                  <FileSpreadsheet className="w-4 h-4 text-accent-amber/70" />
                  <span className="font-mono text-xs text-accent-cream/90 break-all">{sourceLabel}</span>
                  <span className="text-[10px] font-mono text-accent-cream/40 uppercase tracking-[0.2em]">
                    Click or drop to replace
                  </span>
                </div>
              ) : (
                <span className="flex flex-col items-center gap-1 px-3 text-center text-accent-cream/40 font-mono text-xs">
                  <Upload className="w-4 h-4" />
                  <span>Drop or click to load a .md / .markdown file</span>
                  <span className="text-[10px] uppercase tracking-[0.2em] text-accent-cream/30">
                    Markdown mode accepts files only
                  </span>
                </span>
              )}
              {dragActive && (
                <div className="absolute inset-0 pointer-events-none flex items-center justify-center bg-accent-amber/10 text-accent-amber font-mono text-xs uppercase tracking-[0.2em]">
                  Drop to load
                </div>
              )}
            </div>
          ) : (
            <div
              onDrop={onDrop}
              onDragOver={onDragOver}
              onDragEnter={onDragOver}
              onDragLeave={onDragLeave}
              className={`relative border ${
                dragActive ? 'border-accent-amber/60 bg-accent-amber/5' : 'border-accent-amber/10'
              } focus-within:border-accent-amber/30 transition-colors`}
            >
              <textarea
                value={text}
                onChange={(e) => setText(e.target.value)}
                placeholder="Paste prose, a meeting transcript, a brain-dump, or markdown… then hit Extract.&#10;Or drop an .xlsx / .csv / .md / .txt file here."
                rows={10}
                spellCheck={false}
                className="w-full bg-surface-0 text-accent-cream/90 text-xs font-mono p-2 outline-none resize-y border-0"
                disabled={extracting || loadingFile}
                aria-label="Ingest input"
              />
              {dragActive && (
                <div className="absolute inset-0 pointer-events-none flex items-center justify-center bg-accent-amber/10 text-accent-amber font-mono text-xs uppercase tracking-[0.2em]">
                  Drop to load
                </div>
              )}
              {loadingFile && (
                <div className="absolute inset-0 pointer-events-none flex items-center justify-center bg-surface-0/80 text-accent-amber font-mono text-xs uppercase tracking-[0.2em]">
                  <Loader2 className="w-3.5 h-3.5 animate-spin mr-2" /> Reading file…
                </div>
              )}
            </div>
          )}

          <div className="flex items-center gap-2 flex-wrap">
            <input
              ref={fileInputRef}
              type="file"
              accept={shape === 'markdown' ? '.md,.markdown' : '.xlsx,.xls,.xlsm,.csv,.tsv,.md,.markdown,.txt'}
              onChange={(e) => {
                const f = e.target.files?.[0];
                if (f) handleFile(f);
                e.target.value = '';
              }}
              className="hidden"
              aria-label={shape === 'markdown' ? 'Upload markdown file' : 'Upload spreadsheet or text file'}
            />
            {shape !== 'markdown' && (
              <>
                <button
                  type="button"
                  onClick={() => fileInputRef.current?.click()}
                  disabled={extracting || loadingFile}
                  className="flex items-center gap-1.5 px-2 py-1 text-[10px] font-mono uppercase tracking-wider border border-accent-cream/20 text-accent-cream/60 hover:text-accent-cream hover:border-accent-cream/40 disabled:opacity-40 transition-all"
                  title="Upload .xlsx / .csv / .md / .txt"
                >
                  <Upload className="w-3 h-3" /> Upload file
                </button>
                {sourceLabel && sourceLabel !== 'pasted-text' && (
                  <span className="flex items-center gap-1 text-[10px] font-mono text-accent-cream/40 uppercase tracking-wider">
                    <FileSpreadsheet className="w-3 h-3" /> {sourceLabel}
                  </span>
                )}
              </>
            )}
          </div>

          {/* Extract button + inline cost estimate / extraction metadata */}
          <div className="flex items-center gap-3 flex-wrap">
            <button
              onClick={handleExtract}
              disabled={extracting || !text.trim()}
              className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-mono uppercase tracking-wider border border-accent-amber/40 text-accent-amber hover:bg-accent-amber/10 disabled:opacity-40 transition-all"
            >
              {extracting ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Sparkles className="w-3.5 h-3.5" />}
              {extracting ? 'Extracting…' : 'Extract'}
            </button>
            {!extraction && costEstimate && (shape === 'prose' || shape === 'auto') && (
              <div
                className="text-[10px] font-mono text-accent-cream/40 uppercase tracking-wider"
                title="Pre-flight estimate — actual usage shown after extraction. Heuristic: ~4 chars/token + system prompt overhead."
              >
                {formatCostLine(costEstimate)}
              </div>
            )}
            {extraction?._extraction && (
              <div className="text-[10px] font-mono text-accent-cream/40 uppercase tracking-wider">
                {extraction._extraction.chunkCount} chunk{extraction._extraction.chunkCount === 1 ? '' : 's'}
                {extraction._extraction.model ? ` · ${extraction._extraction.model}` : ''}
                {extraction._extraction.tokensUsed ? ` · ~${extraction._extraction.tokensUsed} tok` : ''}
              </div>
            )}
          </div>

          {extractError && (
            <div className="flex items-start gap-2 px-3 py-2 text-xs font-mono border border-accent-red/40 text-accent-red bg-accent-red/5">
              <AlertTriangle className="w-3.5 h-3.5 mt-0.5 flex-shrink-0" />
              <span>{extractError}</span>
            </div>
          )}

          {/* Review section */}
          {candidates.length > 0 && (
            <div className="space-y-3 border-t border-accent-amber/10 pt-4">
              <div className="flex items-center gap-3 flex-wrap">
                <label className="flex items-center gap-2 text-[10px] font-mono uppercase tracking-wider text-accent-cream/50">
                  Project
                  <input
                    type="text"
                    value={projectNameOverride || extraction?.projectName || ''}
                    onChange={(e) => setProjectNameOverride(e.target.value)}
                    className="bg-transparent text-accent-cream/90 border-b border-accent-amber/20 outline-none font-mono normal-case tracking-normal px-1 py-0.5 min-w-[12ch]"
                    placeholder="Inbox"
                  />
                </label>
                <label
                  className="flex items-center gap-2 text-[10px] font-mono uppercase tracking-wider text-accent-cream/50"
                  title="Candidates below this confidence start unchecked. The default sticks across sessions."
                >
                  Threshold
                  <input
                    type="range"
                    min={0}
                    max={1}
                    step={0.05}
                    value={threshold}
                    onChange={(e) => updateThreshold(e.target.value)}
                    className="accent-accent-amber w-20"
                    aria-label="Confidence threshold"
                  />
                  <span className="text-accent-amber/80 tabular-nums">{Math.round(threshold * 100)}%</span>
                </label>
                <span className="text-[10px] font-mono text-accent-cream/40 uppercase tracking-wider">
                  {acceptedCount} / {candidates.length} accepted
                </span>
                <div className="ml-auto flex items-center gap-2">
                  <button
                    onClick={() => setCandidates((cs) => cs.map((c) => ({
                      ...c,
                      _accepted: !existingTitles.has(String(c.title || '').trim().toLowerCase()),
                    })))}
                    className="px-2 py-1 text-[10px] font-mono uppercase tracking-wider border border-accent-cream/20 text-accent-cream/60 hover:text-accent-cream hover:border-accent-cream/40 transition-all"
                  >
                    <Check className="w-3 h-3 inline mr-1" /> All
                  </button>
                  <button
                    onClick={() => setCandidates((cs) => cs.map((c) => ({ ...c, _accepted: false })))}
                    className="px-2 py-1 text-[10px] font-mono uppercase tracking-wider border border-accent-cream/20 text-accent-cream/60 hover:text-accent-cream hover:border-accent-cream/40 transition-all"
                  >
                    <X className="w-3 h-3 inline mr-1" /> None
                  </button>
                </div>
              </div>

              <ol className="space-y-2">
                {candidates.map((c, i) => {
                  const isDup = existingTitles.has(String(c.title || '').trim().toLowerCase());
                  return (
                    <CandidateRow
                      key={c.id}
                      index={i}
                      candidate={c}
                      accepted={!!c._accepted && !isDup}
                      showSource={showSourceUI}
                      lowConfidence={typeof c._confidence === 'number' && c._confidence < threshold}
                      isDuplicate={isDup}
                      onToggle={() => {
                        if (isDup) return;
                        setCandidates((cs) => cs.map((x, j) => (j === i ? { ...x, _accepted: !x._accepted } : x)));
                      }}
                      onTitleEdit={(v) => setCandidates((cs) => cs.map((x, j) => {
                        if (j !== i) return x;
                        const nextDup = existingTitles.has(String(v || '').trim().toLowerCase());
                        return { ...x, title: v, _accepted: x._accepted && !nextDup };
                      }))}
                      onDescriptionEdit={(v) => setCandidates((cs) => cs.map((x, j) => (j === i ? { ...x, description: v } : x)))}
                    />
                  );
                })}
              </ol>
            </div>
          )}

          {applyResult && (
            <div
              className={`px-3 py-2 text-xs font-mono border ${
                applyResult.tone === 'ok'   ? 'border-accent-green/40 text-accent-green bg-accent-green/5' :
                applyResult.tone === 'warn' ? 'border-accent-amber/40 text-accent-amber bg-accent-amber/5' :
                                              'border-accent-red/40 text-accent-red bg-accent-red/5'
              }`}
            >
              {applyResult.text}
            </div>
          )}
        </div>

        <div className="flex items-center justify-end gap-2 px-4 py-3 border-t border-accent-amber/10">
          <button
            onClick={onClose}
            className="px-3 py-1.5 text-xs font-mono uppercase tracking-wider border border-accent-cream/20 text-accent-cream/60 hover:text-accent-cream hover:border-accent-cream/40 transition-all"
          >
            Close
          </button>
          <button
            onClick={handleApply}
            disabled={applying || candidates.length === 0 || acceptedCount === 0}
            className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-mono uppercase tracking-wider border border-accent-green/40 text-accent-green hover:bg-accent-green/10 disabled:opacity-40 transition-all"
          >
            {applying ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Play className="w-3.5 h-3.5" />}
            {applying ? 'Applying…' : `Apply (${acceptedCount})`}
          </button>
        </div>
      </div>
    </div>
  );
}
