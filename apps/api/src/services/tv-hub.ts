import type { TvDownMsg } from "@robot/shared";

export type TvListener = (msg: TvDownMsg) => void;

/**
 * Pubsub keyed by bridgeId for TV display messages.
 *
 * This is parallel to the session-scoped TV channel inside SessionHub — the
 * bridge now drives OpenAI Realtime directly, so it publishes display events
 * per-bridge rather than per-session. A TV tab opens `/tv/bridge/:bridgeId`
 * and subscribes; the bridge POSTs into `/api/bridge/:bridgeId/tv/*` and we
 * fan out here.
 */
export class TvHub {
  private subs = new Map<string, Set<TvListener>>();
  /** Most recent content per bridge, replayed to new subscribers so a TV
   *  that opens mid-session sees the current screen. */
  private latest = new Map<string, TvDownMsg>();
  /** Most recent idle-config per bridge — replayed separately so the TV
   *  remembers the background even after the current content is cleared. */
  private latestIdle = new Map<string, TvDownMsg>();

  subscribe(bridgeId: string, listener: TvListener): () => void {
    let set = this.subs.get(bridgeId);
    if (!set) {
      set = new Set();
      this.subs.set(bridgeId, set);
    }
    set.add(listener);
    const idle = this.latestIdle.get(bridgeId);
    if (idle) {
      try { listener(idle); } catch { /* ignore */ }
    }
    const snapshot = this.latest.get(bridgeId);
    if (snapshot) {
      try { listener(snapshot); } catch { /* ignore */ }
    }
    return () => {
      const s = this.subs.get(bridgeId);
      if (!s) return;
      s.delete(listener);
      if (s.size === 0) this.subs.delete(bridgeId);
    };
  }

  publish(bridgeId: string, msg: TvDownMsg): number {
    if (msg.type === "display" || msg.type === "clear") {
      this.latest.set(bridgeId, msg);
    } else if (msg.type === "idle-config") {
      this.latestIdle.set(bridgeId, msg);
    }
    const set = this.subs.get(bridgeId);
    if (!set) return 0;
    for (const fn of set) {
      try { fn(msg); } catch { /* ignore */ }
    }
    return set.size;
  }

  subscriberCount(bridgeId: string): number {
    return this.subs.get(bridgeId)?.size ?? 0;
  }

  currentContent(bridgeId: string): TvDownMsg | null {
    return this.latest.get(bridgeId) ?? null;
  }
}
