import { useEffect, useRef, useState, useCallback } from "react";
import { useNavigate } from "react-router-dom";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import * as faceapi from "face-api.js";
import type { PersonDTO, Gender } from "@robot/shared";
import { api, ApiError } from "@/lib/api";
import PageHeader from "@/components/PageHeader";
import { useToast } from "@/hooks/useToast";

const GENDER_OPTIONS: { value: Gender | ""; label: string }[] = [
  { value: "", label: "Não informado" },
  { value: "male", label: "Masculino" },
  { value: "female", label: "Feminino" },
  { value: "other", label: "Outro" },
];

export default function PersonCreate() {
  const navigate = useNavigate();
  const qc = useQueryClient();
  const toast = useToast();
  const fileInputRef = useRef<HTMLInputElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const videoRef = useRef<HTMLVideoElement>(null);
  const streamRef = useRef<MediaStream | null>(null);

  const [modelsLoaded, setModelsLoaded] = useState(false);
  const [name, setName] = useState("");
  const [phone, setPhone] = useState("");
  const [gender, setGender] = useState<Gender | "">("");
  const [context, setContext] = useState("");
  const [photoPreview, setPhotoPreview] = useState<string | null>(null);
  const [faceDescriptor, setFaceDescriptor] = useState<number[] | null>(null);
  const [detecting, setDetecting] = useState(false);
  const [faceError, setFaceError] = useState<string | null>(null);
  const [webcamMode, setWebcamMode] = useState(false);
  const [webcamReady, setWebcamReady] = useState(false);

  // Load face-api.js models
  useEffect(() => {
    async function loadModels() {
      try {
        const modelPath = "/models";
        await Promise.all([
          faceapi.nets.tinyFaceDetector.loadFromUri(modelPath),
          faceapi.nets.faceLandmark68Net.loadFromUri(modelPath),
          faceapi.nets.faceRecognitionNet.loadFromUri(modelPath),
        ]);
        setModelsLoaded(true);
      } catch (err) {
        console.error("Failed to load face-api models:", err);
        toast.error("Erro ao carregar modelos de detecção facial");
      }
    }
    void loadModels();
  }, [toast]);

  // Cleanup webcam on unmount
  useEffect(() => {
    return () => {
      if (streamRef.current) {
        streamRef.current.getTracks().forEach((track) => track.stop());
      }
    };
  }, []);

  const startWebcam = useCallback(async () => {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: "user", width: 640, height: 480 },
      });
      streamRef.current = stream;
      if (videoRef.current) {
        videoRef.current.srcObject = stream;
        await videoRef.current.play();
        setWebcamReady(true);
      }
      setWebcamMode(true);
    } catch (err) {
      console.error("Failed to start webcam:", err);
      toast.error("Erro ao acessar a câmera. Verifique as permissões.");
    }
  }, [toast]);

  const stopWebcam = useCallback(() => {
    if (streamRef.current) {
      streamRef.current.getTracks().forEach((track) => track.stop());
      streamRef.current = null;
    }
    if (videoRef.current) {
      videoRef.current.srcObject = null;
    }
    setWebcamMode(false);
    setWebcamReady(false);
  }, []);

  const capturePhoto = useCallback(async () => {
    if (!videoRef.current || !canvasRef.current) return;

    const video = videoRef.current;
    const canvas = canvasRef.current;

    canvas.width = video.videoWidth;
    canvas.height = video.videoHeight;

    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    // Draw video frame to canvas
    ctx.drawImage(video, 0, 0);

    // Get data URL
    const dataUrl = canvas.toDataURL("image/jpeg", 0.9);
    setPhotoPreview(dataUrl);

    // Stop webcam
    stopWebcam();

    // Detect face
    if (modelsLoaded) {
      await detectFace(dataUrl);
    }
  }, [modelsLoaded, stopWebcam]);

  const createMutation = useMutation({
    mutationFn: (data: {
      name: string;
      faceDescriptor: number[];
      photoUrl?: string | null;
      phone?: string | null;
      gender?: string | null;
      context?: string | null;
    }) => api.post<PersonDTO>("/api/persons", data),
    onSuccess: (person) => {
      qc.invalidateQueries({ queryKey: ["persons"] });
      toast.success("Pessoa cadastrada com sucesso!");
      navigate(`/admin/persons/${person.id}`);
    },
    onError: (err) => {
      const msg = err instanceof ApiError ? err.message : "Falha ao cadastrar";
      toast.error(msg);
    },
  });

  async function handleFileChange(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;

    setFaceError(null);
    setFaceDescriptor(null);

    // Create preview
    const reader = new FileReader();
    reader.onload = async (event) => {
      const dataUrl = event.target?.result as string;
      setPhotoPreview(dataUrl);

      // Detect face
      if (modelsLoaded) {
        await detectFace(dataUrl);
      }
    };
    reader.readAsDataURL(file);
  }

  async function detectFace(imageDataUrl: string) {
    setDetecting(true);
    setFaceError(null);

    try {
      // Create image element
      const img = new Image();
      img.crossOrigin = "anonymous";

      await new Promise<void>((resolve, reject) => {
        img.onload = () => resolve();
        img.onerror = () => reject(new Error("Failed to load image"));
        img.src = imageDataUrl;
      });

      // Detect face and get descriptor
      const detection = await faceapi
        .detectSingleFace(img, new faceapi.TinyFaceDetectorOptions({ inputSize: 320 }))
        .withFaceLandmarks()
        .withFaceDescriptor();

      if (!detection) {
        setFaceError("Nenhum rosto detectado na imagem. Tente outra foto.");
        setFaceDescriptor(null);
        return;
      }

      // Draw face detection on canvas
      if (canvasRef.current) {
        const canvas = canvasRef.current;
        canvas.width = img.width;
        canvas.height = img.height;
        const ctx = canvas.getContext("2d");
        if (ctx) {
          ctx.drawImage(img, 0, 0);
          const box = detection.detection.box;
          ctx.strokeStyle = "#22c55e";
          ctx.lineWidth = 3;
          ctx.strokeRect(box.x, box.y, box.width, box.height);
        }
      }

      setFaceDescriptor(Array.from(detection.descriptor));
      toast.success("Rosto detectado com sucesso!");
    } catch (err) {
      console.error("Face detection error:", err);
      setFaceError("Erro ao processar a imagem. Tente outra foto.");
    } finally {
      setDetecting(false);
    }
  }

  function resetPhoto() {
    setPhotoPreview(null);
    setFaceDescriptor(null);
    setFaceError(null);
    if (fileInputRef.current) {
      fileInputRef.current.value = "";
    }
  }

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault();

    if (!name.trim()) {
      toast.error("Nome é obrigatório");
      return;
    }

    if (!faceDescriptor) {
      toast.error("É necessário uma foto com rosto detectado");
      return;
    }

    createMutation.mutate({
      name: name.trim(),
      faceDescriptor,
      photoUrl: photoPreview,
      phone: phone.trim() || null,
      gender: gender || null,
      context: context.trim() || null,
    });
  }

  return (
    <div className="max-w-2xl mx-auto">
      <PageHeader
        title="Nova Pessoa"
        subtitle="Cadastre uma nova pessoa para reconhecimento facial."
        actions={
          <button
            type="button"
            onClick={() => navigate("/admin/persons")}
            className="btn-ghost"
          >
            Cancelar
          </button>
        }
      />

      <form onSubmit={handleSubmit} className="space-y-6">
        {/* Photo Capture */}
        <div className="card p-6">
          <h3 className="text-sm font-medium mb-4">Foto</h3>

          <div className="flex gap-6">
            {/* Photo/Video area */}
            <div className="flex-1">
              {webcamMode ? (
                <div className="relative">
                  <video
                    ref={videoRef}
                    autoPlay
                    playsInline
                    muted
                    className="w-full max-w-sm rounded-lg border-2 border-accent"
                  />
                  <canvas ref={canvasRef} className="hidden" />

                  {webcamReady && (
                    <div className="mt-3 flex gap-2">
                      <button
                        type="button"
                        onClick={capturePhoto}
                        className="btn-primary flex-1"
                      >
                        Capturar Foto
                      </button>
                      <button
                        type="button"
                        onClick={stopWebcam}
                        className="btn-ghost"
                      >
                        Cancelar
                      </button>
                    </div>
                  )}
                </div>
              ) : photoPreview ? (
                <div className="relative">
                  <canvas
                    ref={canvasRef}
                    className="w-full max-w-sm rounded-lg border-2 border-border"
                    style={{ display: faceDescriptor ? "block" : "none" }}
                  />
                  {!faceDescriptor && (
                    <img
                      src={photoPreview}
                      alt="Preview"
                      className="w-full max-w-sm rounded-lg border-2 border-border"
                    />
                  )}
                  {detecting && (
                    <div className="absolute inset-0 flex items-center justify-center bg-black/50 rounded-lg">
                      <span className="text-white text-sm">Detectando rosto...</span>
                    </div>
                  )}

                  <button
                    type="button"
                    onClick={resetPhoto}
                    className="mt-2 text-sm text-fg-muted hover:text-fg"
                  >
                    Trocar foto
                  </button>
                </div>
              ) : (
                <div className="space-y-3">
                  {/* Webcam button */}
                  <button
                    type="button"
                    onClick={startWebcam}
                    disabled={!modelsLoaded}
                    className="w-full max-w-sm h-48 border-2 border-dashed border-border rounded-lg flex flex-col items-center justify-center gap-3 hover:border-accent transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
                  >
                    <svg
                      className="w-12 h-12 text-fg-muted"
                      fill="none"
                      stroke="currentColor"
                      viewBox="0 0 24 24"
                    >
                      <path
                        strokeLinecap="round"
                        strokeLinejoin="round"
                        strokeWidth={1.5}
                        d="M15 10l4.553-2.276A1 1 0 0121 8.618v6.764a1 1 0 01-1.447.894L15 14M5 18h8a2 2 0 002-2V8a2 2 0 00-2-2H5a2 2 0 00-2 2v8a2 2 0 002 2z"
                      />
                    </svg>
                    <span className="text-sm text-fg-muted">
                      {modelsLoaded ? "Usar Webcam" : "Carregando modelos..."}
                    </span>
                  </button>

                  {/* Or divider */}
                  <div className="flex items-center gap-3 max-w-sm">
                    <div className="flex-1 border-t border-border" />
                    <span className="text-xs text-fg-muted">ou</span>
                    <div className="flex-1 border-t border-border" />
                  </div>

                  {/* Upload button */}
                  <button
                    type="button"
                    onClick={() => fileInputRef.current?.click()}
                    disabled={!modelsLoaded}
                    className="w-full max-w-sm py-3 border border-border rounded-lg flex items-center justify-center gap-2 hover:border-accent transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
                  >
                    <svg
                      className="w-5 h-5 text-fg-muted"
                      fill="none"
                      stroke="currentColor"
                      viewBox="0 0 24 24"
                    >
                      <path
                        strokeLinecap="round"
                        strokeLinejoin="round"
                        strokeWidth={1.5}
                        d="M4 16l4.586-4.586a2 2 0 012.828 0L16 16m-2-2l1.586-1.586a2 2 0 012.828 0L20 14m-6-6h.01M6 20h12a2 2 0 002-2V6a2 2 0 00-2-2H6a2 2 0 00-2 2v12a2 2 0 002 2z"
                      />
                    </svg>
                    <span className="text-sm text-fg-muted">Enviar arquivo</span>
                  </button>
                </div>
              )}

              <input
                ref={fileInputRef}
                type="file"
                accept="image/*"
                onChange={handleFileChange}
                className="hidden"
              />
            </div>

            {/* Status */}
            <div className="w-48">
              <div className="space-y-3">
                <div
                  className={`flex items-center gap-2 text-sm ${
                    modelsLoaded ? "text-green-400" : "text-fg-muted"
                  }`}
                >
                  {modelsLoaded ? (
                    <svg className="w-5 h-5" fill="currentColor" viewBox="0 0 20 20">
                      <path
                        fillRule="evenodd"
                        d="M10 18a8 8 0 100-16 8 8 0 000 16zm3.707-9.293a1 1 0 00-1.414-1.414L9 10.586 7.707 9.293a1 1 0 00-1.414 1.414l2 2a1 1 0 001.414 0l4-4z"
                        clipRule="evenodd"
                      />
                    </svg>
                  ) : (
                    <svg className="w-5 h-5 animate-spin" fill="none" viewBox="0 0 24 24">
                      <circle
                        className="opacity-25"
                        cx="12"
                        cy="12"
                        r="10"
                        stroke="currentColor"
                        strokeWidth="4"
                      />
                      <path
                        className="opacity-75"
                        fill="currentColor"
                        d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z"
                      />
                    </svg>
                  )}
                  Modelos carregados
                </div>

                <div
                  className={`flex items-center gap-2 text-sm ${
                    photoPreview ? "text-green-400" : "text-fg-muted"
                  }`}
                >
                  {photoPreview ? (
                    <svg className="w-5 h-5" fill="currentColor" viewBox="0 0 20 20">
                      <path
                        fillRule="evenodd"
                        d="M10 18a8 8 0 100-16 8 8 0 000 16zm3.707-9.293a1 1 0 00-1.414-1.414L9 10.586 7.707 9.293a1 1 0 00-1.414 1.414l2 2a1 1 0 001.414 0l4-4z"
                        clipRule="evenodd"
                      />
                    </svg>
                  ) : (
                    <div className="w-5 h-5 rounded-full border-2 border-current" />
                  )}
                  Foto capturada
                </div>

                <div
                  className={`flex items-center gap-2 text-sm ${
                    faceDescriptor
                      ? "text-green-400"
                      : faceError
                      ? "text-red-400"
                      : "text-fg-muted"
                  }`}
                >
                  {faceDescriptor ? (
                    <svg className="w-5 h-5" fill="currentColor" viewBox="0 0 20 20">
                      <path
                        fillRule="evenodd"
                        d="M10 18a8 8 0 100-16 8 8 0 000 16zm3.707-9.293a1 1 0 00-1.414-1.414L9 10.586 7.707 9.293a1 1 0 00-1.414 1.414l2 2a1 1 0 001.414 0l4-4z"
                        clipRule="evenodd"
                      />
                    </svg>
                  ) : faceError ? (
                    <svg className="w-5 h-5" fill="currentColor" viewBox="0 0 20 20">
                      <path
                        fillRule="evenodd"
                        d="M10 18a8 8 0 100-16 8 8 0 000 16zM8.707 7.293a1 1 0 00-1.414 1.414L8.586 10l-1.293 1.293a1 1 0 101.414 1.414L10 11.414l1.293 1.293a1 1 0 001.414-1.414L11.414 10l1.293-1.293a1 1 0 00-1.414-1.414L10 8.586 8.707 7.293z"
                        clipRule="evenodd"
                      />
                    </svg>
                  ) : (
                    <div className="w-5 h-5 rounded-full border-2 border-current" />
                  )}
                  Rosto detectado
                </div>
              </div>

              {faceError && (
                <p className="mt-3 text-xs text-red-400">{faceError}</p>
              )}
            </div>
          </div>
        </div>

        {/* Personal Info */}
        <div className="card p-6">
          <h3 className="text-sm font-medium mb-4">Informações Pessoais</h3>

          <div className="space-y-4 max-w-md">
            <div>
              <label htmlFor="name" className="label">
                Nome *
              </label>
              <input
                id="name"
                type="text"
                value={name}
                onChange={(e) => setName(e.target.value)}
                className="input w-full"
                placeholder="Nome da pessoa"
                required
              />
            </div>

            <div>
              <label htmlFor="phone" className="label">
                Telefone
              </label>
              <input
                id="phone"
                type="tel"
                value={phone}
                onChange={(e) => setPhone(e.target.value)}
                className="input w-full"
                placeholder="(11) 99999-9999"
              />
            </div>

            <div>
              <label htmlFor="gender" className="label">
                Sexo
              </label>
              <select
                id="gender"
                value={gender}
                onChange={(e) => setGender(e.target.value as Gender | "")}
                className="input w-full"
              >
                {GENDER_OPTIONS.map((opt) => (
                  <option key={opt.value} value={opt.value}>
                    {opt.label}
                  </option>
                ))}
              </select>
            </div>
          </div>
        </div>

        {/* Context */}
        <div className="card p-6">
          <h3 className="text-sm font-medium mb-2">Contexto para a IA</h3>
          <p className="text-xs text-fg-muted mb-4">
            Informações que a Sofia deve saber sobre esta pessoa.
          </p>
          <textarea
            value={context}
            onChange={(e) => setContext(e.target.value)}
            className="input w-full h-32 resize-none"
            placeholder="Escreva aqui informações importantes sobre a pessoa que a IA deve considerar durante as conversas..."
          />
        </div>

        {/* Submit */}
        <div className="flex justify-end gap-3">
          <button
            type="button"
            onClick={() => navigate("/admin/persons")}
            className="btn-ghost"
          >
            Cancelar
          </button>
          <button
            type="submit"
            disabled={createMutation.isPending || !faceDescriptor || !name.trim()}
            className="btn-primary"
          >
            {createMutation.isPending ? "Cadastrando..." : "Cadastrar Pessoa"}
          </button>
        </div>
      </form>
    </div>
  );
}
