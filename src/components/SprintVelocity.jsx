import { useState, useMemo } from 'react';
import useStore from '../store/useStore';

export default function SprintVelocity({ projectId }) {
  const sprints = useStore((s) => s.sprints.filter((sp) => sp.projectId === projectId));
  const tasks = useStore((s) => s.tasks);
  const [mode, setMode] = useState('count'); // 'count' | 'points'

  const data = useMemo(() => {
    return sprints.map((sprint) => {
      const sprintTasks = tasks.filter((t) => t.sprintId === sprint.id);
      const done = sprintTasks.filter((t) => t.status === 'done');
      return {
        sprint,
        total: sprintTasks.length,
        done: done.length,
        inProgress: sprintTasks.filter((t) => t.status === 'in-progress').length,
        blocked: sprintTasks.filter((t) => t.status === 'blocked').length,
        todo: sprintTasks.filter((t) => t.status === 'todo').length,
        velocityPoints: done.reduce((sum, t) => sum + (t.difficulty || 5), 0),
      };
    });
  }, [sprints, tasks]);

  const velocity = data.map((d) => mode === 'count' ? d.done : d.velocityPoints);
  const maxVel = Math.max(...velocity, 1);
  const avgVel = velocity.length ? velocity.reduce((a, b) => a + b, 0) / velocity.length : 0;

  if (sprints.length === 0) {
    return (
      <div className="flex items-center justify-center h-full text-xs text-accent-cream/20 font-mono italic">
        No sprints in this project
      </div>
    );
  }

  const chartH = 140;
  const barGap = 8;
  const barMaxW = 48;
  const chartW = Math.max(data.length * (barMaxW + barGap) + barGap, 200);

  return (
    <div className="flex flex-col h-full">
      <div className="flex items-center gap-2 px-4 py-2 border-b border-accent-amber/10 bg-surface-1/50">
        <span className="text-[10px] text-accent-amber/40 font-mono font-medium uppercase tracking-[0.2em] mr-2">Velocity</span>
        {['count', 'points'].map((m) => (
          <button
            key={m}
            onClick={() => setMode(m)}
            className={`px-3 py-1 text-xs font-mono font-medium uppercase tracking-wider transition-all ${mode === m ? 'bg-accent-amber/15 text-accent-amber border border-accent-amber/30' : 'text-accent-cream/30 hover:text-accent-cream/60 border border-transparent'}`}
          >
            {m === 'count' ? 'Tasks' : 'Points'}
          </button>
        ))}
      </div>

      <div className="flex-1 overflow-auto px-4 py-4" style={{ scrollbarWidth: 'thin', scrollbarColor: 'rgba(180,160,100,0.15) transparent' }}>
        {/* Bar chart */}
        <div className="overflow-x-auto">
          <svg width={chartW} height={chartH + 30} className="block">
            {/* Average line */}
            {avgVel > 0 && (
              <>
                <line
                  x1={0} y1={chartH - (avgVel / maxVel) * chartH}
                  x2={chartW} y2={chartH - (avgVel / maxVel) * chartH}
                  stroke="rgba(212,168,67,0.25)" strokeDasharray="4 3" strokeWidth={1}
                />
                <text
                  x={chartW - 4} y={chartH - (avgVel / maxVel) * chartH - 4}
                  fill="rgba(212,168,67,0.35)" fontSize={9} textAnchor="end" fontFamily="monospace"
                >
                  avg {avgVel.toFixed(1)}
                </text>
              </>
            )}

            {data.map((d, i) => {
              const v = mode === 'count' ? d.done : d.velocityPoints;
              const barH = maxVel > 0 ? (v / maxVel) * chartH : 0;
              const x = barGap + i * (barMaxW + barGap);

              return (
                <g key={d.sprint.id}>
                  <rect
                    x={x} y={chartH - barH}
                    width={barMaxW} height={barH}
                    fill="rgba(212,168,67,0.25)" rx={0}
                  />
                  {/* Value label */}
                  {v > 0 && (
                    <text
                      x={x + barMaxW / 2} y={chartH - barH - 5}
                      fill="rgba(212,168,67,0.6)" fontSize={10} textAnchor="middle" fontFamily="monospace"
                    >
                      {v}
                    </text>
                  )}
                  {/* Sprint name */}
                  <text
                    x={x + barMaxW / 2} y={chartH + 14}
                    fill="rgba(245,240,225,0.3)" fontSize={9} textAnchor="middle" fontFamily="monospace"
                  >
                    {d.sprint.name.length > 8 ? d.sprint.name.slice(0, 7) + '\u2026' : d.sprint.name}
                  </text>
                </g>
              );
            })}

            {/* Baseline */}
            <line x1={0} y1={chartH} x2={chartW} y2={chartH} stroke="rgba(180,160,100,0.15)" strokeWidth={1} />
          </svg>
        </div>

        {/* Summary table */}
        <table className="w-full mt-4 text-xs font-mono border-collapse">
          <thead>
            <tr className="border-b border-accent-amber/15">
              <th className="text-left px-2 py-1.5 text-[10px] text-accent-amber/40 uppercase tracking-wider">Sprint</th>
              <th className="text-center px-2 py-1.5 text-[10px] text-accent-amber/40 uppercase">Total</th>
              <th className="text-center px-2 py-1.5 text-[10px] text-accent-amber/40 uppercase">Done</th>
              <th className="text-center px-2 py-1.5 text-[10px] text-accent-amber/40 uppercase">In Prog</th>
              <th className="text-center px-2 py-1.5 text-[10px] text-accent-amber/40 uppercase">Blocked</th>
              <th className="text-center px-2 py-1.5 text-[10px] text-accent-amber/40 uppercase">%</th>
            </tr>
          </thead>
          <tbody>
            {data.map((d) => (
              <tr key={d.sprint.id} className="border-b border-accent-amber/[0.04] hover:bg-accent-amber/[0.05]">
                <td className="px-2 py-1.5 text-accent-cream/60 truncate max-w-[120px]">{d.sprint.name}</td>
                <td className="text-center px-2 py-1.5 text-accent-cream/40">{d.total}</td>
                <td className="text-center px-2 py-1.5 text-accent-green">{d.done}</td>
                <td className="text-center px-2 py-1.5 text-accent-blue">{d.inProgress}</td>
                <td className="text-center px-2 py-1.5 text-accent-red">{d.blocked}</td>
                <td className="text-center px-2 py-1.5 text-accent-amber/60">
                  {d.total > 0 ? Math.round((d.done / d.total) * 100) : 0}%
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
