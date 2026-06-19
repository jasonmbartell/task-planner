import { buildSnapshot } from '../storage/agentSnapshot.js';

export function buildBackup(state, { exportedAt = Date.now() } = {}) {
  const snapshot = buildSnapshot(state, { exportedAt });
  return {
    schemaVersion: snapshot.schemaVersion,
    exportedAt: snapshot.exportedAt,
    projects: snapshot.projects,
    sprints: snapshot.sprints,
    tasks: snapshot.tasks,
  };
}

function timestampSuffix(epochMs) {
  const d = new Date(epochMs);
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
}

export function defaultBackupFilename(epochMs = Date.now()) {
  return `task-planner-backup-${timestampSuffix(epochMs)}.json`;
}

export function downloadBackup(state, { filename, exportedAt } = {}) {
  const ts = exportedAt ?? Date.now();
  const backup = buildBackup(state, { exportedAt: ts });
  const json = JSON.stringify(backup, null, 2);
  const blob = new Blob([json], { type: 'application/json;charset=utf-8;' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename || defaultBackupFilename(ts);
  a.click();
  URL.revokeObjectURL(url);
}
