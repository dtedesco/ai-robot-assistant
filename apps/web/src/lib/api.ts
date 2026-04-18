import { getToken, clearToken } from "./auth";

export const API_URL: string =
  (import.meta.env.VITE_API_URL as string | undefined) ??
  "http://localhost:3000";

export const WS_URL: string =
  (import.meta.env.VITE_WS_URL as string | undefined) ??
  "ws://localhost:3000";

export class ApiError extends Error {
  status: number;
  body: unknown;
  constructor(status: number, message: string, body: unknown) {
    super(message);
    this.status = status;
    this.body = body;
  }
}

export interface ApiRequestInit extends Omit<RequestInit, "body"> {
  body?: unknown;
  auth?: boolean;
}

export async function apiFetch<T = unknown>(
  path: string,
  opts: ApiRequestInit = {},
): Promise<T> {
  const { body, auth = true, headers, ...rest } = opts;

  const h = new Headers(headers);
  if (body !== undefined && !h.has("content-type")) {
    h.set("content-type", "application/json");
  }
  if (auth) {
    const token = getToken();
    if (token) h.set("authorization", `Bearer ${token}`);
  }

  const res = await fetch(`${API_URL}${path}`, {
    ...rest,
    headers: h,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });

  const text = await res.text();
  let parsed: unknown = null;
  if (text) {
    try {
      parsed = JSON.parse(text);
    } catch {
      parsed = text;
    }
  }

  if (!res.ok) {
    if (res.status === 401 && auth) {
      clearToken();
    }
    const message =
      typeof parsed === "object" && parsed !== null && "message" in parsed
        ? String((parsed as { message: unknown }).message)
        : res.statusText || `HTTP ${res.status}`;
    throw new ApiError(res.status, message, parsed);
  }

  return parsed as T;
}

export const api = {
  get: <T>(path: string, opts?: ApiRequestInit) =>
    apiFetch<T>(path, { ...opts, method: "GET" }),
  post: <T>(path: string, body?: unknown, opts?: ApiRequestInit) =>
    apiFetch<T>(path, { ...opts, method: "POST", body }),
  put: <T>(path: string, body?: unknown, opts?: ApiRequestInit) =>
    apiFetch<T>(path, { ...opts, method: "PUT", body }),
  patch: <T>(path: string, body?: unknown, opts?: ApiRequestInit) =>
    apiFetch<T>(path, { ...opts, method: "PATCH", body }),
  delete: <T>(path: string, opts?: ApiRequestInit) =>
    apiFetch<T>(path, { ...opts, method: "DELETE" }),
};
