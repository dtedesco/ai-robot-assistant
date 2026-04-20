import { useEffect, useState, useCallback } from "react";

export interface MediaSettings {
  speakerVolume: number;
  micVolume: number;
  selectedCamera: string;
  selectedMic: string;
  vadThreshold: number;
}

interface SettingsPanelProps {
  isOpen: boolean;
  onClose: () => void;
  settings: MediaSettings;
  onSettingsChange: (settings: MediaSettings) => void;
}

interface MediaDeviceInfo {
  deviceId: string;
  label: string;
  kind: string;
}

const STORAGE_KEY = "robot-media-settings";

export function loadSettings(): MediaSettings {
  const defaults: MediaSettings = {
    speakerVolume: 1.0,
    micVolume: 1.0,
    selectedCamera: "",
    selectedMic: "",
    vadThreshold: 0.5,
  };
  try {
    const stored = localStorage.getItem(STORAGE_KEY);
    if (stored) {
      const parsed = JSON.parse(stored);
      return { ...defaults, ...parsed };
    }
  } catch {
    // ignore
  }
  return defaults;
}

export function saveSettings(settings: MediaSettings): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(settings));
  } catch {
    // ignore
  }
}

export default function SettingsPanel({
  isOpen,
  onClose,
  settings,
  onSettingsChange,
}: SettingsPanelProps) {
  const [cameras, setCameras] = useState<MediaDeviceInfo[]>([]);
  const [mics, setMics] = useState<MediaDeviceInfo[]>([]);
  const [loading, setLoading] = useState(true);
  const [testingMic, setTestingMic] = useState(false);
  const [micLevel, setMicLevel] = useState(0);

  const loadDevices = useCallback(async () => {
    setLoading(true);
    try {
      // Request permission first to get device labels
      await navigator.mediaDevices.getUserMedia({ video: true, audio: true });

      const devices = await navigator.mediaDevices.enumerateDevices();

      const videoDevices = devices
        .filter((d) => d.kind === "videoinput")
        .map((d) => ({
          deviceId: d.deviceId,
          label: d.label || `Camera ${d.deviceId.slice(0, 8)}`,
          kind: d.kind,
        }));

      const audioDevices = devices
        .filter((d) => d.kind === "audioinput")
        .map((d) => ({
          deviceId: d.deviceId,
          label: d.label || `Microphone ${d.deviceId.slice(0, 8)}`,
          kind: d.kind,
        }));

      setCameras(videoDevices);
      setMics(audioDevices);

      // Auto-select first device if none selected
      const firstCamera = videoDevices[0];
      const firstMic = audioDevices[0];
      if (!settings.selectedCamera && firstCamera) {
        onSettingsChange({ ...settings, selectedCamera: firstCamera.deviceId });
      }
      if (!settings.selectedMic && firstMic) {
        onSettingsChange({ ...settings, selectedMic: firstMic.deviceId });
      }
    } catch (err) {
      console.error("Failed to load devices:", err);
    } finally {
      setLoading(false);
    }
  }, [settings, onSettingsChange]);

  useEffect(() => {
    if (isOpen) {
      void loadDevices();
    }
  }, [isOpen, loadDevices]);

  // Mic level meter
  useEffect(() => {
    if (!testingMic || !settings.selectedMic) return;

    let audioContext: AudioContext | null = null;
    let analyser: AnalyserNode | null = null;
    let stream: MediaStream | null = null;
    let animationFrame: number;

    async function startMicTest() {
      try {
        stream = await navigator.mediaDevices.getUserMedia({
          audio: { deviceId: settings.selectedMic ? { exact: settings.selectedMic } : undefined },
        });

        audioContext = new AudioContext();
        analyser = audioContext.createAnalyser();
        analyser.fftSize = 256;

        const source = audioContext.createMediaStreamSource(stream);

        // Apply gain
        const gainNode = audioContext.createGain();
        gainNode.gain.value = settings.micVolume;

        source.connect(gainNode);
        gainNode.connect(analyser);

        const dataArray = new Uint8Array(analyser.frequencyBinCount);

        function updateLevel() {
          if (!analyser) return;
          analyser.getByteFrequencyData(dataArray);
          const average = dataArray.reduce((a, b) => a + b, 0) / dataArray.length;
          setMicLevel(average / 255);
          animationFrame = requestAnimationFrame(updateLevel);
        }

        updateLevel();
      } catch (err) {
        console.error("Failed to start mic test:", err);
        setTestingMic(false);
      }
    }

    void startMicTest();

    return () => {
      cancelAnimationFrame(animationFrame);
      if (stream) {
        stream.getTracks().forEach((t) => t.stop());
      }
      if (audioContext) {
        void audioContext.close();
      }
      setMicLevel(0);
    };
  }, [testingMic, settings.selectedMic, settings.micVolume]);

  function handleChange<K extends keyof MediaSettings>(key: K, value: MediaSettings[K]) {
    const newSettings = { ...settings, [key]: value };
    onSettingsChange(newSettings);
    saveSettings(newSettings);
  }

  if (!isOpen) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70">
      <div className="bg-gray-900 rounded-xl w-full max-w-lg mx-4 overflow-hidden shadow-2xl border border-gray-700">
        {/* Header */}
        <div className="flex items-center justify-between px-6 py-4 border-b border-gray-700">
          <h2 className="text-lg font-semibold text-white">Configurações</h2>
          <button
            type="button"
            onClick={onClose}
            className="text-gray-400 hover:text-white transition-colors"
          >
            <svg className="w-6 h-6" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
        </div>

        {/* Content */}
        <div className="p-6 space-y-6 max-h-[70vh] overflow-y-auto">
          {loading ? (
            <div className="flex items-center justify-center py-8">
              <div className="animate-spin w-8 h-8 border-2 border-blue-500 border-t-transparent rounded-full" />
            </div>
          ) : (
            <>
              {/* Speaker Volume */}
              <div>
                <label className="block text-sm font-medium text-gray-300 mb-2">
                  Volume do Alto-falante
                </label>
                <div className="flex items-center gap-4">
                  <svg className="w-5 h-5 text-gray-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15.536 8.464a5 5 0 010 7.072m2.828-9.9a9 9 0 010 12.728M5.586 15H4a1 1 0 01-1-1v-4a1 1 0 011-1h1.586l4.707-4.707C10.923 3.663 12 4.109 12 5v14c0 .891-1.077 1.337-1.707.707L5.586 15z" />
                  </svg>
                  <input
                    type="range"
                    min="0"
                    max="1"
                    step="0.05"
                    value={settings.speakerVolume}
                    onChange={(e) => handleChange("speakerVolume", parseFloat(e.target.value))}
                    className="flex-1 h-2 bg-gray-700 rounded-lg appearance-none cursor-pointer accent-blue-500"
                  />
                  <span className="text-sm text-gray-400 w-12 text-right">
                    {Math.round(settings.speakerVolume * 100)}%
                  </span>
                </div>
              </div>

              {/* Mic Volume */}
              <div>
                <label className="block text-sm font-medium text-gray-300 mb-2">
                  Ganho do Microfone
                </label>
                <div className="flex items-center gap-4">
                  <svg className="w-5 h-5 text-gray-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 11a7 7 0 01-7 7m0 0a7 7 0 01-7-7m7 7v4m0 0H8m4 0h4m-4-8a3 3 0 01-3-3V5a3 3 0 116 0v6a3 3 0 01-3 3z" />
                  </svg>
                  <input
                    type="range"
                    min="0.1"
                    max="3"
                    step="0.1"
                    value={settings.micVolume}
                    onChange={(e) => handleChange("micVolume", parseFloat(e.target.value))}
                    className="flex-1 h-2 bg-gray-700 rounded-lg appearance-none cursor-pointer accent-blue-500"
                  />
                  <span className="text-sm text-gray-400 w-12 text-right">
                    {Math.round(settings.micVolume * 100)}%
                  </span>
                </div>

                {/* Mic Level Meter */}
                <div className="mt-3 flex items-center gap-3">
                  <button
                    type="button"
                    onClick={() => setTestingMic(!testingMic)}
                    className={`text-xs px-3 py-1 rounded ${
                      testingMic
                        ? "bg-red-600 text-white"
                        : "bg-gray-700 text-gray-300 hover:bg-gray-600"
                    }`}
                  >
                    {testingMic ? "Parar Teste" : "Testar Mic"}
                  </button>
                  {testingMic && (
                    <div className="flex-1 h-2 bg-gray-700 rounded-full overflow-hidden">
                      <div
                        className="h-full bg-green-500 transition-all duration-75"
                        style={{ width: `${micLevel * 100}%` }}
                      />
                    </div>
                  )}
                </div>
              </div>

              {/* Camera Selection */}
              <div>
                <label className="block text-sm font-medium text-gray-300 mb-2">
                  Câmera
                </label>
                <select
                  value={settings.selectedCamera}
                  onChange={(e) => handleChange("selectedCamera", e.target.value)}
                  className="w-full px-4 py-2 bg-gray-800 border border-gray-700 rounded-lg text-white focus:outline-none focus:border-blue-500"
                >
                  {cameras.length === 0 ? (
                    <option value="">Nenhuma câmera encontrada</option>
                  ) : (
                    cameras.map((cam) => (
                      <option key={cam.deviceId} value={cam.deviceId}>
                        {cam.label}
                      </option>
                    ))
                  )}
                </select>
              </div>

              {/* Mic Selection */}
              <div>
                <label className="block text-sm font-medium text-gray-300 mb-2">
                  Microfone
                </label>
                <select
                  value={settings.selectedMic}
                  onChange={(e) => handleChange("selectedMic", e.target.value)}
                  className="w-full px-4 py-2 bg-gray-800 border border-gray-700 rounded-lg text-white focus:outline-none focus:border-blue-500"
                >
                  {mics.length === 0 ? (
                    <option value="">Nenhum microfone encontrado</option>
                  ) : (
                    mics.map((mic) => (
                      <option key={mic.deviceId} value={mic.deviceId}>
                        {mic.label}
                      </option>
                    ))
                  )}
                </select>
              </div>

              {/* VAD Threshold */}
              <div>
                <label className="block text-sm font-medium text-gray-300 mb-2">
                  Sensibilidade do Microfone (VAD)
                </label>
                <div className="flex items-center gap-4">
                  <span className="text-xs text-gray-500">Sensível</span>
                  <input
                    type="range"
                    min="0.2"
                    max="0.9"
                    step="0.05"
                    value={settings.vadThreshold}
                    onChange={(e) => handleChange("vadThreshold", parseFloat(e.target.value))}
                    className="flex-1 h-2 bg-gray-700 rounded-lg appearance-none cursor-pointer accent-blue-500"
                  />
                  <span className="text-xs text-gray-500">Rígido</span>
                  <span className="text-sm text-gray-400 w-12 text-right">
                    {settings.vadThreshold.toFixed(2)}
                  </span>
                </div>
                <p className="mt-1 text-xs text-gray-500">
                  Valores mais altos reduzem eco mas podem cortar fala baixa
                </p>
              </div>

              {/* Refresh Devices */}
              <div className="pt-2">
                <button
                  type="button"
                  onClick={() => void loadDevices()}
                  className="text-sm text-blue-400 hover:text-blue-300 flex items-center gap-2"
                >
                  <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" />
                  </svg>
                  Atualizar dispositivos
                </button>
              </div>
            </>
          )}
        </div>

        {/* Footer */}
        <div className="px-6 py-4 border-t border-gray-700 flex justify-end">
          <button
            type="button"
            onClick={onClose}
            className="px-4 py-2 bg-blue-600 text-white rounded-lg hover:bg-blue-700 transition-colors"
          >
            Fechar
          </button>
        </div>
      </div>
    </div>
  );
}
