import { useEffect } from 'react';

const EDITABLE_TAGS = new Set(['INPUT', 'TEXTAREA', 'SELECT']);

export default function useKeyboardShortcuts({ setView, onNewTask, undo, redo, toggleHelp, closeModal }) {
  useEffect(() => {
    const handler = (e) => {
      const mod = e.ctrlKey || e.metaKey;
      const inEditable = EDITABLE_TAGS.has(e.target.tagName) || e.target.isContentEditable;

      // Ctrl/Cmd shortcuts work even in editable fields
      if (mod && e.key === 'z' && !e.shiftKey) {
        e.preventDefault();
        undo();
        return;
      }
      if (mod && e.key === 'z' && e.shiftKey) {
        e.preventDefault();
        redo();
        return;
      }
      if (mod && e.key === '/') {
        e.preventDefault();
        toggleHelp();
        return;
      }

      // Skip non-modifier shortcuts when in editable fields
      if (inEditable) return;

      switch (e.key) {
        case 'n':
          e.preventDefault();
          onNewTask();
          break;
        case '0':
          setView('agenda');
          break;
        case '1':
          setView('gantt');
          break;
        case '2':
          setView('calendar');
          break;
        case '3':
          setView('spreadsheet');
          break;
        case '?':
          toggleHelp();
          break;
        case 'Escape':
          closeModal();
          break;
      }
    };

    document.addEventListener('keydown', handler);
    return () => document.removeEventListener('keydown', handler);
  }, [setView, onNewTask, undo, redo, toggleHelp, closeModal]);
}
