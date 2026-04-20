/**
 * Bridge-side TV driver. Turns OpenAI Realtime tool calls into HTTP POSTs
 * on the cloud API (`/api/bridge/:bridgeId/tv/*`) which then fan out to
 * any TV pages subscribed to `/ws/tv/bridge/:bridgeId`.
 */
import type { BridgeAgentSummary, TvContent } from "@robot/shared";
import { logger } from "./logger.js";

export interface TvControllerOptions {
  apiBaseUrl: string; // e.g. http://localhost:3000
  bridgeId: string;
  bridgeToken: string;
}

type TvLibraryItem = BridgeAgentSummary["tvLibrary"][number];

export interface TvDisplayState {
  current: TvContent | null;
  library: TvLibraryItem[];
  lastTopic: string | null;
  lastUpdatedAt: string | null;
}

export class TvController {
  private library: TvLibraryItem[] = [];
  private current: TvContent | null = null;
  private lastTopic: string | null = null;
  private lastUpdatedAt: string | null = null;

  constructor(
    private readonly opts: TvControllerOptions,
    private bridgeId: string,
  ) {
    this.bridgeId = bridgeId;
  }

  setBridgeId(bridgeId: string): void {
    this.bridgeId = bridgeId;
  }

  getBridgeId(): string {
    return this.bridgeId;
  }

  getApiBaseUrl(): string {
    return this.opts.apiBaseUrl;
  }

  setLibrary(items: TvLibraryItem[]): void {
    this.library = items ?? [];
    logger.info(`[tv] library updated: ${this.library.length} items`);
  }

  getLibrary(): TvLibraryItem[] {
    return this.library;
  }

  getState(): TvDisplayState {
    return {
      current: this.current,
      library: this.library,
      lastTopic: this.lastTopic,
      lastUpdatedAt: this.lastUpdatedAt,
    };
  }

  /** Convert a library item to a TvContent payload. */
  private itemToContent(item: TvLibraryItem): TvContent | null {
    switch (item.kind) {
      case "youtube":
        if (!item.url) return null;
        return { kind: "youtube", url: item.url, title: item.title };
      case "image":
        if (!item.url) return null;
        return { kind: "image", url: item.url, caption: item.title };
      case "webpage":
        if (!item.url) return null;
        return { kind: "webpage", url: item.url };
      case "text":
        if (!item.text) return null;
        return { kind: "text", text: item.text };
    }
  }

  async showTopic(topic: string): Promise<{ ok: boolean; reason?: string }> {
    const item = this.library.find(
      (i) => i.topic.toLowerCase() === topic.toLowerCase(),
    );
    if (!item) return { ok: false, reason: `unknown topic '${topic}'` };
    const content = this.itemToContent(item);
    if (!content) return { ok: false, reason: `item '${topic}' has no url/text` };
    this.lastTopic = topic;
    return this.display(content);
  }

  async showUrl(url: string, title?: string): Promise<{ ok: boolean; reason?: string }> {
    // Heuristic: YouTube URLs get the embed treatment, everything else → webpage.
    if (/youtu(\.be|be\.com)/.test(url)) {
      return this.display({ kind: "youtube", url, title });
    }
    return this.display({ kind: "webpage", url });
  }

  async showImage(url: string, caption?: string): Promise<{ ok: boolean; reason?: string }> {
    return this.display({ kind: "image", url, caption });
  }

  async clear(): Promise<{ ok: boolean; reason?: string }> {
    this.current = null;
    this.lastTopic = null;
    this.lastUpdatedAt = new Date().toISOString();
    return this.post("clear", undefined);
  }

  /** Push the idle-state background URL to TV subscribers. null restores the
   *  built-in futuristic scene. */
  async setIdleBackground(backgroundUrl: string | null): Promise<{ ok: boolean; reason?: string }> {
    if (!this.bridgeId) return { ok: false, reason: "no bridgeId yet" };
    try {
      const res = await fetch(
        `${this.opts.apiBaseUrl}/api/bridge/${this.bridgeId}/tv/idle-config`,
        {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "x-bridge-token": this.opts.bridgeToken,
          },
          body: JSON.stringify({ backgroundUrl }),
        },
      );
      if (!res.ok) return { ok: false, reason: `HTTP ${res.status}` };
      logger.info(`[tv] idle background → ${backgroundUrl ?? "(default)"}`);
      return { ok: true };
    } catch (err) {
      return { ok: false, reason: (err as Error).message };
    }
  }

  private async display(content: TvContent): Promise<{ ok: boolean; reason?: string }> {
    this.current = content;
    this.lastUpdatedAt = new Date().toISOString();
    return this.post("display", { content });
  }

  private async post(
    action: "display" | "clear",
    body: unknown,
  ): Promise<{ ok: boolean; reason?: string }> {
    const url = `${this.opts.apiBaseUrl}/api/bridge/${this.bridgeId}/tv/${action}`;
    try {
      const res = await fetch(url, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-bridge-token": this.opts.bridgeToken,
        },
        body: body ? JSON.stringify(body) : "{}",
      });
      if (!res.ok) {
        const text = await res.text().catch(() => "");
        logger.warn(`[tv] ${action} HTTP ${res.status}: ${text}`);
        return { ok: false, reason: `HTTP ${res.status}` };
      }
      logger.info(`[tv] ${action} OK`);
      return { ok: true };
    } catch (err) {
      logger.warn(`[tv] ${action} request failed: ${(err as Error).message}`);
      return { ok: false, reason: (err as Error).message };
    }
  }

  /**
   * Register a new person with the pending face descriptor from face detection.
   * The API stores the descriptor that was captured when the face was detected.
   */
  async registerPerson(name: string): Promise<{ ok: boolean; personId?: string; error?: string }> {
    if (!this.bridgeId) {
      return { ok: false, error: "no bridgeId yet" };
    }

    const url = `${this.opts.apiBaseUrl}/api/bridge/${this.bridgeId}/register-person`;
    try {
      const res = await fetch(url, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-bridge-token": this.opts.bridgeToken,
        },
        body: JSON.stringify({ name }),
      });

      if (!res.ok) {
        const text = await res.text().catch(() => "");
        logger.warn(`[tv] register-person HTTP ${res.status}: ${text}`);
        return { ok: false, error: `HTTP ${res.status}: ${text}` };
      }

      const data = (await res.json()) as { id: string; name: string };
      logger.info(`[tv] registered person: ${data.name} (id=${data.id})`);
      return { ok: true, personId: data.id };
    } catch (err) {
      logger.warn(`[tv] register-person request failed: ${(err as Error).message}`);
      return { ok: false, error: (err as Error).message };
    }
  }
}
