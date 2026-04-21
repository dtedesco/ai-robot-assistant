import type { ReactElement } from "react";
import { Navigate, Route, Routes } from "react-router-dom";
import AdminLayout from "@/components/AdminLayout";
import Login from "@/pages/Login";
import AgentsList from "@/pages/AgentsList";
import AgentEdit from "@/pages/AgentEdit";
import PersonsList from "@/pages/PersonsList";
import PersonCreate from "@/pages/PersonCreate";
import PersonEdit from "@/pages/PersonEdit";
import VisitsList from "@/pages/VisitsList";
import ConversationsList from "@/pages/ConversationsList";
import TvDisplay from "@/pages/TvDisplay";
import TvBridgeDisplay from "@/pages/TvBridgeDisplay";
import TvRealtimeDisplay from "@/pages/TvRealtimeDisplay";
import RealtimeDisplay from "@/pages/RealtimeDisplay";
import { useAuth } from "@/hooks/useAuth";

function RequireAuth({ children }: { children: ReactElement }) {
  const { isAuthenticated } = useAuth();
  if (!isAuthenticated) return <Navigate to="/login" replace />;
  return children;
}

export default function App() {
  return (
    <Routes>
      {/* Public displays — no auth, fullscreen */}
      <Route path="/tv/:slug" element={<TvRealtimeDisplay />} />
      <Route path="/agente/:slug" element={<RealtimeDisplay />} />
      {/* Legacy routes for backwards compatibility */}
      <Route path="/tv/bridge/:bridgeId" element={<TvBridgeDisplay />} />
      <Route path="/tv/realtime/:agentId" element={<TvRealtimeDisplay />} />
      <Route path="/realtime/:agentId" element={<RealtimeDisplay />} />

      {/* Login */}
      <Route path="/login" element={<Login />} />

      {/* Admin (authenticated) */}
      <Route
        path="/admin/*"
        element={
          <RequireAuth>
            <AdminLayout />
          </RequireAuth>
        }
      >
        <Route index element={<Navigate to="/admin/agents" replace />} />
        <Route path="agents" element={<AgentsList />} />
        <Route path="agents/new" element={<AgentEdit />} />
        <Route path="agents/:id" element={<AgentEdit />} />
        <Route path="persons" element={<PersonsList />} />
        <Route path="persons/new" element={<PersonCreate />} />
        <Route path="persons/:id" element={<PersonEdit />} />
        <Route path="visits" element={<VisitsList />} />
        <Route path="conversations" element={<ConversationsList />} />
      </Route>
    </Routes>
  );
}
