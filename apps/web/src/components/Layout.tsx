import { NavLink, Outlet, useNavigate } from "react-router-dom";
import { useAuth } from "@/hooks/useAuth";
import {
  AdminWsContext,
  useAdminWsConnection,
} from "@/hooks/useAdminWs";
import StatusBadge from "@/components/StatusBadge";

const NAV_ITEMS = [
  { to: "/agents", label: "Agentes" },
  { to: "/bridges", label: "Bridges" },
  { to: "/connect", label: "Conectar" },
  { to: "/sessions", label: "Sessões" },
];

export default function Layout() {
  const { token, logout } = useAuth();
  const ws = useAdminWsConnection(token);
  const navigate = useNavigate();

  function onLogout() {
    logout();
    navigate("/login", { replace: true });
  }

  return (
    <AdminWsContext.Provider value={ws}>
      <div className="flex h-full min-h-screen bg-bg text-fg">
        <aside className="w-60 shrink-0 border-r border-border bg-bg-elevated flex flex-col">
          <div className="px-5 py-5 border-b border-border">
            <div className="text-sm font-semibold tracking-wide">
              Robot Assistant
            </div>
            <div className="mt-1 text-xs text-fg-muted">Painel administrativo</div>
          </div>

          <nav className="flex-1 p-3 space-y-1">
            {NAV_ITEMS.map((item) => (
              <NavLink
                key={item.to}
                to={item.to}
                className={({ isActive }) =>
                  [
                    "block rounded-md px-3 py-2 text-sm transition-colors",
                    isActive
                      ? "bg-bg-muted text-fg"
                      : "text-fg-muted hover:text-fg hover:bg-bg-muted/60",
                  ].join(" ")
                }
              >
                {item.label}
              </NavLink>
            ))}
          </nav>

          <div className="p-3 border-t border-border">
            <div className="flex items-center justify-between text-xs text-fg-muted px-2 py-1.5">
              <span>WebSocket</span>
              <StatusBadge kind={ws.connected ? "online" : "offline"} />
            </div>
            <button
              type="button"
              onClick={onLogout}
              className="w-full btn-ghost mt-1 justify-start"
            >
              Sair
            </button>
          </div>
        </aside>

        <main className="flex-1 min-w-0 overflow-auto">
          <div className="max-w-6xl mx-auto px-8 py-8">
            <Outlet />
          </div>
        </main>
      </div>
    </AdminWsContext.Provider>
  );
}
