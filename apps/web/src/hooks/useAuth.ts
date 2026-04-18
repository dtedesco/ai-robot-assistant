import { useCallback, useEffect, useState } from "react";
import { api } from "@/lib/api";
import { getToken, setToken, clearToken } from "@/lib/auth";

export interface LoginResponse {
  token: string;
  user?: { id: string; email: string };
}

export function useAuth() {
  const [token, setTokenState] = useState<string | null>(() => getToken());

  useEffect(() => {
    function onStorage(e: StorageEvent) {
      if (e.key === null || e.key === "robot.auth.token") {
        setTokenState(getToken());
      }
    }
    window.addEventListener("storage", onStorage);
    return () => window.removeEventListener("storage", onStorage);
  }, []);

  const login = useCallback(async (email: string, password: string) => {
    const res = await api.post<LoginResponse>(
      "/api/auth/login",
      { email, password },
      { auth: false },
    );
    setToken(res.token);
    setTokenState(res.token);
    return res;
  }, []);

  const logout = useCallback(() => {
    clearToken();
    setTokenState(null);
  }, []);

  return {
    token,
    isAuthenticated: Boolean(token),
    login,
    logout,
  };
}
