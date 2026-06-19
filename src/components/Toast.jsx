import { useEffect } from 'react';
import { AlertTriangle, Info, XCircle, X } from 'lucide-react';
import useStore from '../store/useStore';

const ICONS = {
  warning: AlertTriangle,
  error: XCircle,
  info: Info,
};

const COLORS = {
  warning: 'border-amber-500/60 bg-amber-500/10 text-amber-300',
  error: 'border-red-500/60 bg-red-500/10 text-red-300',
  info: 'border-blue-500/60 bg-blue-500/10 text-blue-300',
};

function ToastItem({ notification }) {
  const dismiss = useStore((s) => s.dismissNotification);
  const Icon = ICONS[notification.type] || Info;

  useEffect(() => {
    const timer = setTimeout(() => dismiss(notification.id), 4000);
    return () => clearTimeout(timer);
  }, [notification.id, dismiss]);

  return (
    <div className={`flex items-start gap-2 px-3 py-2.5 border text-xs font-mono shadow-lg shadow-black/40 animate-slide-in ${COLORS[notification.type] || COLORS.info}`}>
      <Icon className="w-4 h-4 flex-shrink-0 mt-0.5" />
      <span className="flex-1">{notification.message}</span>
      <button onClick={() => dismiss(notification.id)} className="flex-shrink-0 opacity-50 hover:opacity-100 transition-opacity">
        <X className="w-3.5 h-3.5" />
      </button>
    </div>
  );
}

export default function Toast() {
  const notifications = useStore((s) => s._notifications);

  if (!notifications.length) return null;

  return (
    <div className="fixed bottom-4 right-4 z-[60] flex flex-col gap-2 max-w-sm">
      {notifications.map((n) => (
        <ToastItem key={n.id} notification={n} />
      ))}
    </div>
  );
}
