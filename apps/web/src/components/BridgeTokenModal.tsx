import { useEffect, useRef, useState } from "react";

export interface BridgeTokenModalProps {
  bridgeName: string;
  token: string;
  onClose: () => void;
}

export default function BridgeTokenModal({
  bridgeName,
  token,
  onClose,
}: BridgeTokenModalProps) {
  const [copied, setCopied] = useState(false);
  const inputRef = useRef<HTMLInputElement | null>(null);

  // Auto-select the token on mount so the user can Ctrl/Cmd+C immediately.
  useEffect(() => {
    const el = inputRef.current;
    if (el) {
      el.focus();
      el.select();
    }
  }, []);

  // Esc closes the modal.
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") {
        e.stopPropagation();
        onClose();
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  async function copy() {
    try {
      await navigator.clipboard.writeText(token);
      setCopied(true);
      setTimeout(() => setCopied(false), 1800);
    } catch {
      // fallback: try document.execCommand via the focused input
      const el = inputRef.current;
      if (el) {
        el.focus();
        el.select();
        try {
          document.execCommand("copy");
          setCopied(true);
          setTimeout(() => setCopied(false), 1800);
        } catch {
          // ignore
        }
      }
    }
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-4"
      role="dialog"
      aria-modal="true"
      aria-labelledby="bridge-token-title"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div className="card w-full max-w-lg p-6">
        <div className="text-xs uppercase tracking-wide text-fg-muted">
          Nova bridge criada
        </div>
        <div id="bridge-token-title" className="mt-1 text-lg font-semibold">
          {bridgeName}
        </div>

        <div className="mt-4 rounded-md border border-danger/40 bg-danger/10 px-3 py-2 text-xs text-danger">
          Copie este token agora. Ele não será exibido novamente.
        </div>

        <div className="mt-4">
          <div className="label">Token da bridge</div>
          <div className="flex gap-2">
            <input
              ref={inputRef}
              readOnly
              value={token}
              className="input font-mono text-xs"
              onFocus={(e) => e.currentTarget.select()}
            />
            <button
              type="button"
              onClick={copy}
              className={copied ? "btn-primary" : "btn-secondary"}
              aria-label={copied ? "Copiado" : "Copiar token"}
            >
              {copied ? "Copiado!" : "Copiar"}
            </button>
          </div>
        </div>

        <div className="mt-6 flex justify-end">
          <button type="button" onClick={onClose} className="btn-primary">
            Fechar
          </button>
        </div>
      </div>
    </div>
  );
}
