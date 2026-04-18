import { useEffect, useState } from "react";
import type { SessionEvent, AdminDownMsg } from "@robot/shared";
import { useAdminWs } from "./useAdminWs";

export interface UseSessionEventsResult {
  events: SessionEvent[];
  connected: boolean;
}

/**
 * Subscribes to a given session via the admin WS and accumulates events.
 */
export function useSessionEvents(sessionId: string | undefined): UseSessionEventsResult {
  const ws = useAdminWs();
  const [events, setEvents] = useState<SessionEvent[]>([]);

  useEffect(() => {
    if (!sessionId) return;
    setEvents([]);

    const unsubscribe = ws.subscribe((msg: AdminDownMsg) => {
      if (msg.type === "session:event" && msg.sessionId === sessionId) {
        setEvents((prev) => [...prev, msg.event]);
      }
    });

    ws.send({ type: "subscribe", sessionId });

    return () => {
      ws.send({ type: "unsubscribe", sessionId });
      unsubscribe();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessionId, ws.connected]);

  return { events, connected: ws.connected };
}
