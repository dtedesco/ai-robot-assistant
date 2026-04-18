import {
  createContext,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import type { AdminDownMsg, AdminUpMsg } from "@robot/shared";
import { adminWsUrl } from "@/lib/ws";
import { openJsonWs, type JsonWebSocketHandle } from "@/lib/ws";

export type AdminMessageHandler = (msg: AdminDownMsg) => void;

export interface AdminWsContextValue {
  connected: boolean;
  send(msg: AdminUpMsg): void;
  subscribe(handler: AdminMessageHandler): () => void;
}

export const AdminWsContext = createContext<AdminWsContextValue | null>(null);

/**
 * Internal hook used by the context provider in Layout.tsx — opens the
 * admin WS when a token is present and re-opens on token change.
 */
export function useAdminWsConnection(token: string | null): AdminWsContextValue {
  const [connected, setConnected] = useState(false);
  const handleRef = useRef<JsonWebSocketHandle | null>(null);
  const listenersRef = useRef<Set<AdminMessageHandler>>(new Set());

  useEffect(() => {
    if (!token) {
      setConnected(false);
      return;
    }

    const h = openJsonWs(adminWsUrl(), {
      reconnect: true,
      onOpen: () => setConnected(true),
      onClose: () => setConnected(false),
      onMessage: (data) => {
        const msg = data as AdminDownMsg;
        for (const fn of listenersRef.current) fn(msg);
      },
    });
    handleRef.current = h;

    return () => {
      h.close();
      handleRef.current = null;
      setConnected(false);
    };
  }, [token]);

  return useMemo<AdminWsContextValue>(
    () => ({
      connected,
      send(msg) {
        handleRef.current?.send(msg);
      },
      subscribe(fn) {
        listenersRef.current.add(fn);
        return () => {
          listenersRef.current.delete(fn);
        };
      },
    }),
    [connected],
  );
}

export function useAdminWs(): AdminWsContextValue {
  const ctx = useContext(AdminWsContext);
  if (!ctx) {
    throw new Error("useAdminWs must be used within an authenticated Layout");
  }
  return ctx;
}
