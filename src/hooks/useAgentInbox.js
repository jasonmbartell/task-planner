/**
 * useAgentInbox — subscribes to an AgentInboxService and returns a reactive
 * snapshot of the queued-ops list.
 *
 * Consumers: `src/components/AgentInbox.jsx` (view) and `src/components/Sidebar.jsx`
 * (badge count). The service itself is instantiated once in `App.jsx`.
 */

import { useEffect, useState } from 'react';

export default function useAgentInbox(service) {
  const [queued, setQueued] = useState(() => (service ? service.getQueued() : []));

  useEffect(() => {
    if (!service) return undefined;
    const unsub = service.subscribe((next) => setQueued(next));
    return unsub;
  }, [service]);

  return {
    queued,
    count: queued.length,
    approve: (absPath, edited) => service?.approve(absPath, edited),
    reject: (absPath, opts) => service?.reject(absPath, opts),
    refresh: () => service?.refresh(),
  };
}
