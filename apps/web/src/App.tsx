import type { ReactElement } from "react";
import { Navigate, Route, Routes } from "react-router-dom";
import Layout from "@/components/Layout";
import Login from "@/pages/Login";
import AgentsList from "@/pages/AgentsList";
import AgentEdit from "@/pages/AgentEdit";
import BridgesList from "@/pages/BridgesList";
import Connect from "@/pages/Connect";
import SessionsList from "@/pages/SessionsList";
import SessionView from "@/pages/SessionView";
import TvDisplay from "@/pages/TvDisplay";
import TvBridgeDisplay from "@/pages/TvBridgeDisplay";
import { useAuth } from "@/hooks/useAuth";

function RequireAuth({ children }: { children: ReactElement }) {
  const { isAuthenticated } = useAuth();
  if (!isAuthenticated) return <Navigate to="/login" replace />;
  return children;
}

export default function App() {
  return (
    <Routes>
      {/* Public TV display — no auth, fullscreen */}
      <Route path="/tv/bridge/:bridgeId" element={<TvBridgeDisplay />} />
      <Route path="/tv/:sessionId" element={<TvDisplay />} />

      {/* Login */}
      <Route path="/login" element={<Login />} />

      {/* Admin (authenticated) */}
      <Route
        element={
          <RequireAuth>
            <Layout />
          </RequireAuth>
        }
      >
        <Route index element={<Navigate to="/agents" replace />} />
        <Route path="/agents" element={<AgentsList />} />
        <Route path="/agents/new" element={<AgentEdit />} />
        <Route path="/agents/:id" element={<AgentEdit />} />
        <Route path="/bridges" element={<BridgesList />} />
        <Route path="/connect" element={<Connect />} />
        <Route path="/sessions" element={<SessionsList />} />
        <Route path="/sessions/:id" element={<SessionView />} />
      </Route>

      <Route path="*" element={<Navigate to="/agents" replace />} />
    </Routes>
  );
}
