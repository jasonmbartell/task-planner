import { useState, useMemo } from 'react';
import useStore from '../store/useStore';

export default function CsvImportDialog({ parsedTasks, parseErrors, onClose }) {
  const { projects, sprints, addTask, addNotification } = useStore();

  const sprintOptions = useMemo(() => {
    return sprints.map((s) => {
      const proj = projects.find((p) => p.id === s.projectId);
      return { id: s.id, label: `${proj?.name || '?'} / ${s.name}`, projectId: s.projectId };
    });
  }, [sprints, projects]);

  const [fallbackSprintId, setFallbackSprintId] = useState(sprintOptions[0]?.id || '');

  const resolvedTasks = useMemo(() => {
    const projectMap = {};
    for (const p of projects) projectMap[p.name.toLowerCase()] = p.id;

    const sprintByProject = {};
    for (const s of sprints) {
      const key = `${s.projectId}::${s.name.toLowerCase()}`;
      sprintByProject[key] = s.id;
    }

    return parsedTasks.map((t) => {
      let sprintId = null;
      if (t._projectName && t._sprintName) {
        const projId = projectMap[t._projectName.toLowerCase()];
        if (projId) {
          sprintId = sprintByProject[`${projId}::${t._sprintName.toLowerCase()}`] || null;
        }
      }
      return { ...t, sprintId: sprintId || fallbackSprintId };
    });
  }, [parsedTasks, projects, sprints, fallbackSprintId]);

  const handleImport = () => {
    let count = 0;
    for (const t of resolvedTasks) {
      if (!t.sprintId) continue;
      addTask({
        title: t.title,
        status: t.status,
        startDate: t.startDate,
        endDate: t.endDate,
        dueDate: t.dueDate,
        urgency: t.urgency,
        importance: t.importance,
        difficulty: t.difficulty,
        sprintId: t.sprintId,
      });
      count++;
    }
    addNotification(`Imported ${count} task${count !== 1 ? 's' : ''}.`, 'info');
    onClose();
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center" onClick={onClose}>
      <div className="absolute inset-0 bg-black/50" />
      <div
        className="relative bg-surface-1 border border-accent-amber/20 shadow-2xl shadow-black/60 p-5 w-full max-w-2xl max-h-[80vh] flex flex-col"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between mb-4">
          <h3 className="text-xs font-semibold text-accent-amber uppercase tracking-[0.2em] font-mono">
            Import CSV — {parsedTasks.length} task{parsedTasks.length !== 1 ? 's' : ''}
          </h3>
          <button onClick={onClose} className="p-1 hover:bg-accent-amber/10 text-accent-cream/30 hover:text-accent-amber transition font-mono">
            &#x2715;
          </button>
        </div>

        {parseErrors.length > 0 && (
          <div className="mb-3 px-3 py-2 border border-red-500/30 bg-red-500/10 text-xs text-red-300 font-mono">
            {parseErrors.map((err, i) => (
              <div key={i}>{typeof err === 'string' ? err : `Row ${err.row}: ${err.message}`}</div>
            ))}
          </div>
        )}

        <div className="mb-3 flex items-center gap-3">
          <label className="text-[10px] text-accent-cream/50 font-mono uppercase tracking-wider whitespace-nowrap">
            Fallback sprint:
          </label>
          <select
            value={fallbackSprintId}
            onChange={(e) => setFallbackSprintId(e.target.value)}
            className="flex-1 bg-surface-2 border border-accent-amber/20 text-xs text-accent-cream/70 px-2 py-1 font-mono"
          >
            {sprintOptions.map((s) => (
              <option key={s.id} value={s.id}>{s.label}</option>
            ))}
          </select>
        </div>

        <div className="flex-1 overflow-auto border border-accent-amber/10" style={{ scrollbarWidth: 'thin', scrollbarColor: 'rgba(180,160,100,0.15) transparent' }}>
          <table className="w-full text-xs font-mono border-collapse">
            <thead>
              <tr className="bg-surface-0/80 border-b border-accent-amber/15">
                <th className="text-left px-2 py-1.5 text-[10px] text-accent-amber/40 uppercase">Title</th>
                <th className="text-left px-2 py-1.5 text-[10px] text-accent-amber/40 uppercase">Status</th>
                <th className="text-left px-2 py-1.5 text-[10px] text-accent-amber/40 uppercase">Due</th>
                <th className="text-left px-2 py-1.5 text-[10px] text-accent-amber/40 uppercase">Sprint</th>
              </tr>
            </thead>
            <tbody>
              {resolvedTasks.map((t, i) => {
                const sprint = sprintOptions.find((s) => s.id === t.sprintId);
                return (
                  <tr key={i} className="border-b border-accent-amber/[0.04] hover:bg-accent-amber/[0.05]">
                    <td className="px-2 py-1 text-accent-cream/70 truncate max-w-[200px]">{t.title}</td>
                    <td className="px-2 py-1 text-accent-cream/50 uppercase">{t.status}</td>
                    <td className="px-2 py-1 text-accent-cream/40">{t.dueDate || '—'}</td>
                    <td className="px-2 py-1 text-accent-cream/40">{sprint?.label || 'unmapped'}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>

        <div className="flex justify-end gap-2 mt-4">
          <button
            onClick={onClose}
            className="px-3 py-1.5 text-xs font-mono text-accent-cream/50 hover:text-accent-cream hover:bg-accent-amber/10 transition"
          >
            Cancel
          </button>
          <button
            onClick={handleImport}
            disabled={!fallbackSprintId || parsedTasks.length === 0}
            className="px-4 py-1.5 text-xs font-mono bg-accent-amber/15 text-accent-amber hover:bg-accent-amber/25 transition disabled:opacity-30 disabled:cursor-not-allowed"
          >
            Import {parsedTasks.length} task{parsedTasks.length !== 1 ? 's' : ''}
          </button>
        </div>
      </div>
    </div>
  );
}
