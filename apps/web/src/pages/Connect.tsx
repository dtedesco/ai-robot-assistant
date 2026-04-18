import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { useMutation, useQuery } from "@tanstack/react-query";
import type {
  AgentDTO,
  BLEDevice,
  BridgeDTO,
  SessionDTO,
} from "@robot/shared";
import { api, ApiError } from "@/lib/api";
import PageHeader from "@/components/PageHeader";
import Spinner from "@/components/Spinner";
import { useToast } from "@/hooks/useToast";

/**
 * NOTE: the endpoints below are assumed to exist on the backend. If any is
 * missing, the UI will surface the error and the corresponding step will be
 * TODO on the API side:
 *   - POST /api/bridges/:id/scan            -> { devices: BLEDevice[] }
 *   - POST /api/bridges/:id/connect-ble     -> { ok: true }  body: { address }
 *   - POST /api/sessions                    -> SessionDTO    body: { agentId, bridgeId }
 */
export default function Connect() {
  const navigate = useNavigate();
  const toast = useToast();

  const bridgesQuery = useQuery<BridgeDTO[]>({
    queryKey: ["bridges"],
    queryFn: () => api.get<BridgeDTO[]>("/api/bridges"),
    refetchInterval: 5000,
  });

  const agentsQuery = useQuery<AgentDTO[]>({
    queryKey: ["agents"],
    queryFn: () => api.get<AgentDTO[]>("/api/agents"),
  });

  const [bridgeId, setBridgeId] = useState<string>("");
  const [devices, setDevices] = useState<BLEDevice[] | null>(null);
  const [deviceAddr, setDeviceAddr] = useState<string>("");
  const [agentId, setAgentId] = useState<string>("");

  const scanMutation = useMutation({
    mutationFn: (id: string) =>
      api.post<{ devices: BLEDevice[] }>(`/api/bridges/${id}/scan`),
    onSuccess: (res) => {
      setDevices(res.devices ?? []);
      const n = res.devices?.length ?? 0;
      toast.info(
        n === 0
          ? "Nenhum dispositivo encontrado."
          : `${n} dispositivo(s) encontrado(s).`,
      );
    },
    onError: (err) => {
      const msg = err instanceof ApiError ? err.message : "Falha no scan";
      toast.error(msg);
    },
  });

  const connectMutation = useMutation({
    mutationFn: (params: { bridgeId: string; address: string }) =>
      api.post<{ ok: boolean }>(`/api/bridges/${params.bridgeId}/connect-ble`, {
        address: params.address,
      }),
    onSuccess: () => toast.success("Conectado ao dispositivo."),
    onError: (err) => {
      const msg =
        err instanceof ApiError ? err.message : "Falha ao conectar BLE";
      toast.error(msg);
    },
  });

  const startSessionMutation = useMutation({
    mutationFn: (params: { agentId: string; bridgeId: string }) =>
      api.post<SessionDTO>("/api/sessions", params),
    onSuccess: (s) => {
      toast.success("Sessão iniciada.");
      navigate(`/sessions/${s.id}`);
    },
    onError: (err) => {
      const msg =
        err instanceof ApiError ? err.message : "Falha ao iniciar sessão";
      toast.error(msg);
    },
  });

  const busy =
    scanMutation.isPending ||
    connectMutation.isPending ||
    startSessionMutation.isPending;

  function onScan() {
    if (!bridgeId) {
      toast.error("Selecione uma bridge");
      return;
    }
    setDevices(null);
    scanMutation.mutate(bridgeId);
  }

  function onConnect() {
    if (!bridgeId || !deviceAddr) {
      toast.error("Selecione uma bridge e um dispositivo");
      return;
    }
    connectMutation.mutate({ bridgeId, address: deviceAddr });
  }

  function onStart() {
    if (!bridgeId || !agentId) {
      toast.error("Selecione bridge e agente");
      return;
    }
    startSessionMutation.mutate({ agentId, bridgeId });
  }

  const bridges = bridgesQuery.data ?? [];
  const onlineBridges = bridges.filter((b) => b.status === "online");

  return (
    <div>
      <PageHeader
        title="Conectar"
        subtitle="Inicie uma nova sessão conectando o robô através de uma bridge."
      />

      <div className="space-y-6">
        <section className="card p-6 space-y-4">
          <div className="text-sm font-semibold">1. Bridge</div>
          <div>
            <label className="label">Selecione a bridge</label>
            <select
              className="input"
              value={bridgeId}
              onChange={(e) => {
                setBridgeId(e.target.value);
                setDevices(null);
                setDeviceAddr("");
              }}
              disabled={busy}
            >
              <option value="">—</option>
              {bridges.map((b) => (
                <option
                  key={b.id}
                  value={b.id}
                  disabled={b.status !== "online"}
                >
                  {b.name} {b.status !== "online" ? "(offline)" : ""}
                </option>
              ))}
            </select>
            {onlineBridges.length === 0 && bridges.length > 0 && (
              <p className="mt-2 text-xs text-fg-muted">
                Nenhuma bridge online. Inicie o daemon local primeiro.
              </p>
            )}
          </div>
        </section>

        <section className="card p-6 space-y-4">
          <div className="flex items-center justify-between">
            <div className="text-sm font-semibold">2. Dispositivo BLE</div>
            <button
              type="button"
              onClick={onScan}
              disabled={!bridgeId || busy}
              className="btn-secondary"
            >
              {scanMutation.isPending ? (
                <Spinner label="Scaneando..." />
              ) : (
                "Scan"
              )}
            </button>
          </div>

          {devices === null ? (
            <p className="text-xs text-fg-muted">
              Clique em Scan para buscar dispositivos BLE.
            </p>
          ) : devices.length === 0 ? (
            <p className="text-xs text-fg-muted">Nenhum dispositivo encontrado.</p>
          ) : (
            <div className="divide-y divide-border-subtle border border-border rounded-md">
              {devices.map((d) => (
                <label
                  key={d.address}
                  className="flex items-center gap-3 px-3 py-2 cursor-pointer hover:bg-bg-muted/60"
                >
                  <input
                    type="radio"
                    name="device"
                    value={d.address}
                    checked={deviceAddr === d.address}
                    onChange={() => setDeviceAddr(d.address)}
                    className="accent-accent"
                    disabled={busy}
                  />
                  <div className="flex-1 min-w-0">
                    <div className="text-sm">{d.name ?? "(sem nome)"}</div>
                    <div className="text-xs text-fg-muted font-mono">
                      {d.address}
                    </div>
                  </div>
                  <div className="text-xs text-fg-subtle">{d.rssi} dBm</div>
                </label>
              ))}
            </div>
          )}

          <div className="flex justify-end">
            <button
              type="button"
              onClick={onConnect}
              disabled={!bridgeId || !deviceAddr || busy}
              className="btn-secondary"
            >
              {connectMutation.isPending ? (
                <Spinner label="Conectando..." />
              ) : (
                "Conectar"
              )}
            </button>
          </div>
        </section>

        <section className="card p-6 space-y-4">
          <div className="text-sm font-semibold">3. Agente</div>
          <div>
            <label className="label">Selecione o agente</label>
            <select
              className="input"
              value={agentId}
              onChange={(e) => setAgentId(e.target.value)}
              disabled={busy}
            >
              <option value="">—</option>
              {(agentsQuery.data ?? []).map((a) => (
                <option key={a.id} value={a.id}>
                  {a.name}
                </option>
              ))}
            </select>
          </div>

          <div className="flex justify-end">
            <button
              type="button"
              onClick={onStart}
              disabled={!bridgeId || !agentId || busy}
              className="btn-primary"
            >
              {startSessionMutation.isPending ? (
                <Spinner label="Iniciando..." />
              ) : (
                "Iniciar sessão"
              )}
            </button>
          </div>
        </section>
      </div>
    </div>
  );
}
