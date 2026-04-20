/**
 * Realtime Display - Agent control interface.
 *
 * This screen handles:
 * - OpenAI Realtime (direct connection)
 * - Microphone capture
 * - Speaker playback
 * - Camera + face detection
 *
 * TV content is sent to a separate TvRealtimeDisplay via API.
 */
import { useEffect, useState, useRef, useCallback } from "react";
import { useParams } from "react-router-dom";
import type { TvContent } from "@robot/shared";
import { API_URL } from "@/lib/api";
import { apiQueue } from "@/lib/async-queue";
import { useFaceDetection, type FaceBox } from "@/hooks/useFaceDetection";
import { useAudioCapture } from "@/hooks/useAudioCapture";
import { useAudioPlayback } from "@/hooks/useAudioPlayback";
import { RealtimeClient, type RealtimePhase, type RealtimeTool } from "@/lib/realtime-client";
import SettingsPanel, { loadSettings, saveSettings, type MediaSettings } from "@/components/SettingsPanel";

interface AgentConfig {
  id: string;
  name: string;
  greeting: string | null;
  tvLibrary: TvLibraryItem[];
  tvIdleBackgroundUrl: string | null;
}

interface TvLibraryItem {
  topic: string;
  kind: "youtube" | "image" | "webpage" | "text";
  url?: string;
  text?: string;
  title?: string;
}

interface IdentifiedPerson {
  personId: string;
  name: string;
  context?: string | null;
  preferences?: string[];
  gender?: string | null;
}

interface RealtimeCredentials {
  apiKey: string;
  model: string;
  voice: string;
  instructions: string;
  tools: RealtimeTool[];
  agent: AgentConfig;
}

// ============================================================
// ASYNC API HELPERS - Fire-and-forget for maximum fluidity
// ============================================================

/**
 * Send TV command (fire-and-forget via queue).
 */
function sendTvCommand(agentId: string, endpoint: string, body?: object): void {
  apiQueue.enqueue(async () => {
    const options: RequestInit = { method: "POST" };
    if (body) {
      options.headers = { "Content-Type": "application/json" };
      options.body = JSON.stringify(body);
    }
    const res = await fetch(`${API_URL}/api/realtime/${agentId}/tv/${endpoint}`, options);
    if (!res.ok) throw new Error(`TV ${endpoint} failed: ${res.status}`);
  });
}

/**
 * Create visit - returns immediately with optimistic ID.
 * The real ID is fetched in background and updated via callback.
 */
function createVisitAsync(
  personId: string,
  agentId: string,
  onCreated: (visitId: string) => void,
): void {
  apiQueue.enqueue(async () => {
    const res = await fetch(`${API_URL}/api/visits`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ personId, agentId }),
    });
    if (res.ok) {
      const data = await res.json();
      onCreated(data.id);
    }
  });
}

/**
 * End visit (fire-and-forget).
 */
function endVisitAsync(visitId: string): void {
  apiQueue.enqueue(async () => {
    await fetch(`${API_URL}/api/visits/${visitId}/end`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });
  });
}

/**
 * Save conversation message (fire-and-forget via queue).
 * Uses queue to maintain order without blocking.
 */
function saveConversationAsync(
  personId: string | null,
  agentId: string,
  visitId: string | null,
  role: "user" | "assistant",
  content: string,
): void {
  if (!content.trim()) return;
  apiQueue.enqueue(async () => {
    const res = await fetch(`${API_URL}/api/conversations`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ personId, agentId, visitId, role, content }),
    });
    if (!res.ok) throw new Error(`Conversation save failed: ${res.status}`);
  });
}

// Helper to capture photo from video
function capturePhoto(video: HTMLVideoElement): string | null {
  try {
    const canvas = document.createElement("canvas");
    canvas.width = video.videoWidth;
    canvas.height = video.videoHeight;
    const ctx = canvas.getContext("2d");
    if (!ctx) return null;
    // Mirror the image (since video is mirrored)
    ctx.translate(canvas.width, 0);
    ctx.scale(-1, 1);
    ctx.drawImage(video, 0, 0);
    return canvas.toDataURL("image/jpeg", 0.8);
  } catch (err) {
    console.error("[photo] capture failed:", err);
    return null;
  }
}

// Helper to register unknown person with photo
async function registerUnknownPerson(
  descriptor: number[],
  photoDataUrl: string | null,
): Promise<{ id: string; name: string } | null> {
  try {
    const timestamp = new Date().toLocaleString("pt-BR", {
      day: "2-digit",
      month: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
    });
    const name = `Visitante ${timestamp}`;

    const res = await fetch(`${API_URL}/api/persons`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name,
        faceDescriptor: descriptor,
        photoUrl: photoDataUrl,
      }),
    });
    if (res.ok) {
      const person = await res.json();
      console.log("[person] registered unknown:", person.name);
      return { id: person.id, name: person.name };
    }
  } catch (err) {
    console.error("[person] register failed:", err);
  }
  return null;
}

export default function RealtimeDisplay() {
  const { agentId } = useParams<{ agentId: string }>();

  // Conversation message type
  interface ChatMessage {
    id: string;
    role: "user" | "assistant";
    content: string;
    timestamp: Date;
  }

  // State
  const [phase, setPhase] = useState<RealtimePhase>("idle");
  const [agentConfig, setAgentConfig] = useState<AgentConfig | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [isStarted, setIsStarted] = useState(false);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [currentTranscript, setCurrentTranscript] = useState<string>("");
  const messagesEndRef = useRef<HTMLDivElement>(null);

  // Settings state
  const [settings, setSettings] = useState<MediaSettings>(loadSettings);
  const [isSettingsOpen, setIsSettingsOpen] = useState(false);

  const handleSettingsChange = useCallback((newSettings: MediaSettings) => {
    setSettings(newSettings);
    saveSettings(newSettings);
  }, []);

  // Face detection state
  const [identifiedPerson, setIdentifiedPerson] = useState<IdentifiedPerson | null>(null);
  const identifiedPersonRef = useRef<IdentifiedPerson | null>(null); // Ref for callbacks
  const [pendingDescriptor, setPendingDescriptor] = useState<number[] | null>(null);
  const lastGreetingTime = useRef<number>(0);
  const lastPersonId = useRef<string | null>(null); // Track for session reset on person change
  const currentVisitId = useRef<string | null>(null); // Track current visit for logging
  const matchInProgress = useRef<boolean>(false); // Track if match API call is in flight
  const matchCompleted = useRef<boolean>(false); // Track if initial match is done
  const pendingGreeting = useRef<boolean>(false); // Track if greeting is pending (face idle before match)

  // Refs
  const videoRef = useRef<HTMLVideoElement>(null);
  const cameraStreamRef = useRef<MediaStream | null>(null);
  const realtimeRef = useRef<RealtimeClient | null>(null);
  const tvLibraryRef = useRef<TvLibraryItem[]>([]);
  const agentIdRef = useRef<string>(""); // URL param (slug or ID) - used for TV commands
  const realAgentIdRef = useRef<string>(""); // Real agent ID from credentials - used for DB operations

  // Track if there's a face - only capture audio when someone is present
  const hasFaceRef = useRef<boolean>(false);

  // Audio playback
  // Track if currently speaking (to mute mic during playback)
  const isSpeakingRef = useRef(false);

  const {
    playChunk: rawPlayChunk,
    endPlayback,
  } = useAudioPlayback({
    volume: settings.speakerVolume,
    onPlaybackStart: () => {
      console.log("[audio] playback started");
    },
    onPlaybackEnd: () => {
      console.log("[audio] playback ended");
      isSpeakingRef.current = false;
      // Clear TV after a delay
      setTimeout(() => {
        if (agentIdRef.current) {
          void sendTvCommand(agentIdRef.current, "clear");
        }
      }, 5000);
    },
  });

  // Wrapper to mute mic IMMEDIATELY when receiving audio (before playback starts)
  // Also clear the audio input buffer to prevent echo from being processed
  const playChunk = useCallback((pcmBase64: string) => {
    if (!isSpeakingRef.current) {
      isSpeakingRef.current = true; // Mute mic immediately
      // Clear audio buffer to prevent any captured echo from being processed
      realtimeRef.current?.clearAudioBuffer();
    }
    rawPlayChunk(pcmBase64);
  }, [rawPlayChunk]);

  // Audio capture - only send audio when face is present and not speaking
  const handleAudioChunk = useCallback((pcmBase64: string) => {
    if (hasFaceRef.current && !isSpeakingRef.current) {
      realtimeRef.current?.sendAudio(pcmBase64);
    }
  }, []);

  const { isCapturing } = useAudioCapture(handleAudioChunk, {
    enabled: isStarted,
    gain: settings.micVolume,
    deviceId: settings.selectedMic || undefined,
  });

  // Initialize camera only after started (video element is in DOM)
  useEffect(() => {
    if (!isStarted) return;

    const videoConstraints: MediaTrackConstraints = {
      width: { ideal: 640 },
      height: { ideal: 480 },
    };

    // Use selected camera if available, otherwise use user-facing camera
    if (settings.selectedCamera) {
      videoConstraints.deviceId = { exact: settings.selectedCamera };
    } else {
      videoConstraints.facingMode = "user";
    }

    navigator.mediaDevices
      .getUserMedia({ video: videoConstraints })
      .then((stream) => {
        cameraStreamRef.current = stream;
        if (videoRef.current) {
          videoRef.current.srcObject = stream;
        }
      })
      .catch((err) => {
        console.error("Camera error:", err);
      });

    return () => {
      if (cameraStreamRef.current) {
        cameraStreamRef.current.getTracks().forEach((t) => t.stop());
        cameraStreamRef.current = null;
      }
    };
  }, [isStarted, settings.selectedCamera]);

  // Trigger greeting message - fully synchronous, no awaits
  const triggerGreeting = useCallback(() => {
    const now = Date.now();
    if (now - lastGreetingTime.current < 30000) return;
    lastGreetingTime.current = now;

    const realtime = realtimeRef.current;
    if (!realtime?.isConnected()) return;

    // Use ref to get current person
    const currentPerson = identifiedPersonRef.current;

    // Create visit async (fire-and-forget, visit ID updated via callback)
    if (currentPerson && realAgentIdRef.current) {
      // End any previous visit first (fire-and-forget)
      if (currentVisitId.current) {
        endVisitAsync(currentVisitId.current);
        currentVisitId.current = null;
      }
      // Create new visit async
      createVisitAsync(currentPerson.personId, realAgentIdRef.current, (visitId) => {
        currentVisitId.current = visitId;
        console.log("[visit] created:", visitId, "for", currentPerson.name);
      });
    }

    // Check if person name starts with "Visitante" (auto-registered unknown)
    const isUnknown = currentPerson?.name.startsWith("Visitante");

    if (currentPerson && !isUnknown) {
      console.log("[greeting] personalized for:", currentPerson.name);

      // Build context string with all available info
      let contextInfo = "";
      if (currentPerson.context) {
        contextInfo += `\n\nInformações importantes sobre ${currentPerson.name}: ${currentPerson.context}`;
      }
      if (currentPerson.preferences && currentPerson.preferences.length > 0) {
        contextInfo += `\n\nPreferências: ${currentPerson.preferences.join(", ")}`;
      }
      if (currentPerson.gender) {
        const genderText = currentPerson.gender === "male" ? "masculino" :
                          currentPerson.gender === "female" ? "feminino" : "outro";
        contextInfo += `\n\nGênero: ${genderText}`;
      }

      realtime.injectSystemMessage(
        `Uma pessoa conhecida chamada "${currentPerson.name}" acabou de se aproximar. ` +
        `Cumprimente-a pelo nome de forma amigável e calorosa.${contextInfo}`
      );
    } else {
      console.log("[greeting] generic for unknown person");
      realtime.injectSystemMessage(
        `Uma pessoa desconhecida acabou de se aproximar. ` +
        `Cumprimente-a de forma amigável e pergunte o nome.`
      );
    }
    realtime.triggerResponse();
  }, []);

  // Face detection callbacks
  const handleFaceDetected = useCallback(async (descriptor: number[]) => {
    hasFaceRef.current = true;
    setPendingDescriptor(descriptor);

    // Cancel any pending farewell
    if (farewellTimer.current) {
      clearTimeout(farewellTimer.current);
      farewellTimer.current = null;
    }

    // Skip if match already in progress or completed
    if (matchInProgress.current || (matchCompleted.current && identifiedPersonRef.current)) {
      return;
    }

    console.log("[face] Starting new face match...");

    // Mark match as in progress
    matchInProgress.current = true;
    matchCompleted.current = false;

    try {
      const res = await fetch(`${API_URL}/api/persons/match`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ descriptor, threshold: 0.6 }),
      });
      const data = await res.json();

      let person: {
        id: string;
        name: string;
        context?: string | null;
        preferences?: string[];
        gender?: string | null;
      } | null = null;

      if (data.matched && data.person) {
        person = {
          id: data.person.id,
          name: data.person.name,
          context: data.person.context,
          preferences: data.person.preferences,
          gender: data.person.gender,
        };
      } else {
        // Unknown person - auto-register with photo
        const photo = videoRef.current ? capturePhoto(videoRef.current) : null;
        person = await registerUnknownPerson(descriptor, photo);
      }

      const newPersonId = person?.id ?? "unknown";

      // Check if person changed - reset conversation and clear messages
      if (lastPersonId.current && lastPersonId.current !== newPersonId) {
        console.log("[face] Person changed, resetting conversation");
        realtimeRef.current?.resetConversation();
        lastGreetingTime.current = 0;
        setMessages([]); // Clear messages for new person
      }
      lastPersonId.current = newPersonId;

      if (person) {
        const identified: IdentifiedPerson = {
          personId: person.id,
          name: person.name,
          context: person.context,
          preferences: person.preferences,
          gender: person.gender,
        };
        setIdentifiedPerson(identified);
        identifiedPersonRef.current = identified;
      } else {
        setIdentifiedPerson(null);
        identifiedPersonRef.current = null;
      }

      // Mark match as completed
      matchInProgress.current = false;
      matchCompleted.current = true;

      console.log("[face] Match completed, person:", identifiedPersonRef.current?.name ?? "unknown");

      // Trigger greeting after delay (wait for face to stabilize)
      setTimeout(() => {
        if (hasFaceRef.current) {
          triggerGreeting();
        }
      }, 2000);
    } catch (err) {
      console.error("Face match error:", err);
      matchInProgress.current = false;
      matchCompleted.current = true;
    }
  }, [triggerGreeting]);

  const handleFaceIdle = useCallback(() => {
    console.log("[face] Face idle detected");
  }, []);

  const lastFarewellTime = useRef<number>(0);
  const farewellTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const leavingPersonRef = useRef<IdentifiedPerson | null>(null);

  const handleFaceLost = useCallback(() => {
    hasFaceRef.current = false;
    leavingPersonRef.current = identifiedPerson;

    // Clear any existing farewell timer
    if (farewellTimer.current) {
      clearTimeout(farewellTimer.current);
    }

    // Wait 3 seconds before saying goodbye (in case person comes back)
    farewellTimer.current = setTimeout(() => {
      // Check if face came back during the delay
      if (hasFaceRef.current) {
        console.log("[farewell] cancelled - face returned");
        return;
      }

      const leavingPerson = leavingPersonRef.current;

      // End visit async (fire-and-forget)
      if (currentVisitId.current) {
        endVisitAsync(currentVisitId.current);
        currentVisitId.current = null;
      }

      // Trigger farewell if we had a greeting recently
      const now = Date.now();
      const timeSinceGreeting = now - lastGreetingTime.current;
      const timeSinceFarewell = now - lastFarewellTime.current;

      if (timeSinceGreeting < 120000 && timeSinceFarewell > 30000) {
        const realtime = realtimeRef.current;
        if (realtime?.isConnected()) {
          lastFarewellTime.current = now;

          const personName = leavingPerson?.name.startsWith("Visitante")
            ? "a pessoa"
            : leavingPerson?.name;

          if (personName) {
            realtime.injectSystemMessage(
              `${personName} está saindo. Dê um tchau rápido e simpático.`
            );
          } else {
            realtime.injectSystemMessage(
              `A pessoa está saindo. Dê um tchau rápido e simpático.`
            );
          }
          realtime.triggerResponse();
        }
      }

      // Reset context after farewell (wait for speech to complete)
      setTimeout(() => {
        console.log("[context] resetting for next person");
        setIdentifiedPerson(null);
        identifiedPersonRef.current = null;
        setPendingDescriptor(null);
        setMessages([]);
        lastPersonId.current = null;
        leavingPersonRef.current = null;
        matchInProgress.current = false;
        matchCompleted.current = false;
        pendingGreeting.current = false;
        realtimeRef.current?.resetConversation();
      }, 5000);

    }, 3000); // 3 second delay before goodbye
  }, [identifiedPerson]);

  // Face detection hook
  const { isReady: faceReady, hasDetection, faceBox } = useFaceDetection(
    videoRef,
    {
      enabled: isStarted,
      detectionIntervalMs: 500,
      idleTimeoutMs: 3000,
      minConfidence: 0.5,
    },
    handleFaceDetected,
    handleFaceIdle,
    handleFaceLost,
  );

  // Convert library item to TvContent
  function itemToContent(item: TvLibraryItem): TvContent | null {
    switch (item.kind) {
      case "youtube":
        return item.url ? { kind: "youtube", url: item.url, title: item.title } : null;
      case "image":
        return item.url ? { kind: "image", url: item.url, caption: item.title } : null;
      case "webpage":
        return item.url ? { kind: "webpage", url: item.url } : null;
      case "text":
        return item.text ? { kind: "text", text: item.text } : null;
    }
  }

  // Tool call handler - sends TV commands to API
  const handleToolCall = useCallback(async (
    name: string,
    args: Record<string, unknown>,
  ): Promise<unknown> => {
    console.log("[tool]", name, args);
    const id = agentIdRef.current;

    if (name === "show_tv") {
      const topic = args.topic as string;
      const item = tvLibraryRef.current.find(
        (i) => i.topic.toLowerCase() === topic.toLowerCase()
      );
      if (item) {
        const content = itemToContent(item);
        if (content) {
          await sendTvCommand(id, "display", { content });
          return { ok: true };
        }
      }
      return { ok: false, reason: "topic not found" };
    }

    if (name === "show_url") {
      const url = args.url as string;
      const title = args.title as string | undefined;
      const content: TvContent = /youtu(\.be|be\.com)/.test(url)
        ? { kind: "youtube", url, title }
        : { kind: "webpage", url };
      await sendTvCommand(id, "display", { content });
      return { ok: true };
    }

    if (name === "show_image") {
      const url = args.url as string;
      const caption = args.caption as string | undefined;
      await sendTvCommand(id, "display", { content: { kind: "image", url, caption } });
      return { ok: true };
    }

    if (name === "clear_tv") {
      await sendTvCommand(id, "clear");
      return { ok: true };
    }

    if (name === "register_person") {
      const personName = args.name as string;
      if (!personName) {
        return { ok: false, reason: "no name provided" };
      }

      // If we already have an identified person (auto-registered), update their name
      const currentPersonId = lastPersonId.current;
      if (currentPersonId && currentPersonId !== "unknown") {
        try {
          const res = await fetch(`${API_URL}/api/persons/${currentPersonId}`, {
            method: "PATCH",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ name: personName }),
          });
          if (res.ok) {
            const person = await res.json();
            const identified: IdentifiedPerson = {
              personId: person.id,
              name: person.name,
              context: person.context,
              preferences: person.preferences,
              gender: person.gender,
            };
            setIdentifiedPerson(identified);
            identifiedPersonRef.current = identified;
            console.log("[person] updated name:", personName);
            return { ok: true, message: `Prazer em conhecer você, ${personName}!` };
          }
        } catch (err) {
          console.error("[person] update failed:", err);
        }
      }

      // Fallback: create new person if no current person
      if (pendingDescriptor) {
        try {
          const photo = videoRef.current ? capturePhoto(videoRef.current) : null;
          const res = await fetch(`${API_URL}/api/persons`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              name: personName,
              faceDescriptor: pendingDescriptor,
              photoUrl: photo,
            }),
          });
          if (res.ok) {
            const person = await res.json();
            const identified: IdentifiedPerson = {
              personId: person.id,
              name: person.name,
              context: person.context,
              preferences: person.preferences,
              gender: person.gender,
            };
            setIdentifiedPerson(identified);
            identifiedPersonRef.current = identified;
            lastPersonId.current = person.id;
            setPendingDescriptor(null);
            return { ok: true, message: `${personName} registrado!` };
          }
        } catch (err) {
          return { ok: false, reason: (err as Error).message };
        }
      }

      return { ok: false, reason: "could not register" };
    }

    return { ok: false, reason: "unknown tool" };
  }, [pendingDescriptor]);

  // Start realtime
  const startRealtime = useCallback(async () => {
    if (!agentId) return;
    agentIdRef.current = agentId;

    try {
      setError(null);
      const res = await fetch(`${API_URL}/api/realtime/credentials/${agentId}`);
      if (!res.ok) {
        const err = await res.json();
        throw new Error(err.message || "Failed to get credentials");
      }

      const creds: RealtimeCredentials = await res.json();
      setAgentConfig(creds.agent);
      tvLibraryRef.current = creds.agent.tvLibrary;
      realAgentIdRef.current = creds.agent.id; // Store real agent ID for DB operations

      // Set idle background on TV
      if (creds.agent.tvIdleBackgroundUrl) {
        await sendTvCommand(agentId, "idle", { backgroundUrl: creds.agent.tvIdleBackgroundUrl });
      }

      // Create and configure realtime client
      const client = new RealtimeClient();
      realtimeRef.current = client;

      client.configure(
        {
          apiKey: creds.apiKey,
          model: creds.model,
          voice: creds.voice,
          instructions: creds.instructions,
          tools: creds.tools,
          vadThreshold: settings.vadThreshold,
        },
        {
          onPhaseChange: setPhase,
          onAudioDelta: playChunk,
          onAudioDone: endPlayback,
          onUserTranscript: (text) => {
            console.log("[user]", text);
            setCurrentTranscript(text);
            // Add to messages array (immediate UI update)
            setMessages((prev) => [
              ...prev,
              { id: crypto.randomUUID(), role: "user", content: text, timestamp: new Date() },
            ]);
            // Save to server async (fire-and-forget)
            const personId = lastPersonId.current !== "unknown" ? lastPersonId.current : null;
            saveConversationAsync(personId, realAgentIdRef.current, currentVisitId.current, "user", text);
          },
          onAssistantTranscript: (text) => {
            console.log("[assistant]", text);
            setCurrentTranscript(text);
            // Add to messages array (immediate UI update)
            setMessages((prev) => [
              ...prev,
              { id: crypto.randomUUID(), role: "assistant", content: text, timestamp: new Date() },
            ]);
            // Save to server async (fire-and-forget)
            const personId = lastPersonId.current !== "unknown" ? lastPersonId.current : null;
            saveConversationAsync(personId, realAgentIdRef.current, currentVisitId.current, "assistant", text);
          },
          onToolCall: handleToolCall,
          onError: (err) => {
            console.error("[realtime error]", err);
            setError(err);
          },
        }
      );

      client.start();
      setIsStarted(true);
    } catch (err) {
      setError((err as Error).message);
    }
  }, [agentId, playChunk, endPlayback, handleToolCall]);

  // Cleanup
  useEffect(() => {
    return () => {
      realtimeRef.current?.stop();
      apiQueue.clear(); // Clear pending API calls
      if (farewellTimer.current) {
        clearTimeout(farewellTimer.current);
      }
    };
  }, []);

  // Update VAD threshold when settings change
  useEffect(() => {
    if (isStarted && realtimeRef.current) {
      realtimeRef.current.updateVadThreshold(settings.vadThreshold);
    }
  }, [isStarted, settings.vadThreshold]);

  // Scroll to bottom when messages change
  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages]);

  const handleStart = () => {
    void startRealtime();
  };

  // Start screen
  if (!isStarted) {
    return (
      <div className="w-screen h-screen bg-gradient-to-br from-gray-900 to-black flex flex-col items-center justify-center gap-8">
        <h1 className="text-4xl font-bold text-white">Robot Assistant</h1>
        <p className="text-gray-400">Tela do Agente (Mic + Câmera)</p>
        {error && <p className="text-red-500">{error}</p>}
        <div className="flex items-center gap-4">
          <button
            onClick={handleStart}
            className="px-8 py-4 bg-blue-600 hover:bg-blue-700 text-white text-xl font-semibold rounded-lg transition-colors"
          >
            Iniciar
          </button>
          <button
            type="button"
            onClick={() => setIsSettingsOpen(true)}
            className="p-4 bg-gray-700 hover:bg-gray-600 text-white rounded-lg transition-colors"
            title="Configurações"
          >
            <svg className="w-6 h-6" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                strokeWidth={2}
                d="M10.325 4.317c.426-1.756 2.924-1.756 3.35 0a1.724 1.724 0 002.573 1.066c1.543-.94 3.31.826 2.37 2.37a1.724 1.724 0 001.065 2.572c1.756.426 1.756 2.924 0 3.35a1.724 1.724 0 00-1.066 2.573c.94 1.543-.826 3.31-2.37 2.37a1.724 1.724 0 00-2.572 1.065c-.426 1.756-2.924 1.756-3.35 0a1.724 1.724 0 00-2.573-1.066c-1.543.94-3.31-.826-2.37-2.37a1.724 1.724 0 00-1.065-2.572c-1.756-.426-1.756-2.924 0-3.35a1.724 1.724 0 001.066-2.573c-.94-1.543.826-3.31 2.37-2.37.996.608 2.296.07 2.572-1.065z"
              />
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                strokeWidth={2}
                d="M15 12a3 3 0 11-6 0 3 3 0 016 0z"
              />
            </svg>
          </button>
        </div>
        <p className="text-gray-500 text-sm">
          Clique para permitir microfone e câmera
        </p>
        {agentId && (
          <p className="text-gray-600 text-xs mt-4">
            TV: <code className="bg-gray-800 px-2 py-1 rounded">/tv/realtime/{agentId}</code>
          </p>
        )}

        {/* Settings Panel */}
        <SettingsPanel
          isOpen={isSettingsOpen}
          onClose={() => setIsSettingsOpen(false)}
          settings={settings}
          onSettingsChange={handleSettingsChange}
        />
      </div>
    );
  }

  // Main interface
  return (
    <div className="w-screen h-screen bg-gradient-to-br from-gray-900 to-black overflow-hidden flex">
      {/* Left side - Camera and Status */}
      <div className="flex-1 flex flex-col min-w-0">
        {/* Camera preview */}
        <div className="flex-1 flex items-center justify-center p-6">
          <div className="relative w-full max-w-xl aspect-video bg-black rounded-2xl overflow-hidden shadow-2xl">
            <video
              ref={videoRef}
              autoPlay
              muted
              playsInline
              className="w-full h-full object-cover mirror"
            />

            {/* Face bounding box overlay */}
            {faceReady && hasDetection && faceBox && videoRef.current && (
              <FaceOverlay
                faceBox={faceBox}
                videoWidth={videoRef.current.videoWidth}
                videoHeight={videoRef.current.videoHeight}
                personName={identifiedPerson?.name ?? null}
              />
            )}

            <style>{`
              .mirror {
                transform: scaleX(-1);
              }
            `}</style>
          </div>
        </div>

        {/* Status bar */}
        <div className="p-4 bg-black/50 border-t border-white/10">
          <div className="flex items-center justify-between">
            {/* Agent info */}
            <div>
              <h2 className="text-white font-semibold">{agentConfig?.name}</h2>
              <p className="text-gray-500 text-sm">
                {phase === "speaking" && "Falando..."}
                {phase === "listening" && "Ouvindo..."}
                {phase === "thinking" && "Pensando..."}
                {phase === "connecting" && "Conectando..."}
                {phase === "idle" && "Aguardando"}
              </p>
            </div>

            {/* Status indicators */}
            <div className="flex items-center gap-4">
              {/* Phase indicator */}
              <div className="flex items-center gap-2">
                <div
                  className={`w-3 h-3 rounded-full ${
                    phase === "speaking"
                      ? "bg-blue-500 animate-pulse"
                      : phase === "listening"
                      ? "bg-green-500"
                      : phase === "thinking"
                      ? "bg-yellow-500 animate-pulse"
                      : phase === "connecting"
                      ? "bg-orange-500 animate-pulse"
                      : "bg-gray-500"
                  }`}
                />
              </div>

              {/* Mic indicator */}
              {isCapturing && phase !== "speaking" && (
                <div className="flex items-center gap-2">
                  <div className="w-3 h-3 rounded-full bg-red-500 animate-pulse" />
                  <span className="text-xs text-red-400">MIC</span>
                </div>
              )}

              {/* Face indicator */}
              {faceReady && (
                <div className="flex items-center gap-2">
                  <div
                    className={`w-3 h-3 rounded-full ${
                      hasDetection ? "bg-green-500" : "bg-gray-600"
                    }`}
                  />
                  <span className="text-xs text-gray-400">CAM</span>
                </div>
              )}

              {/* Settings button */}
              <button
                type="button"
                onClick={() => setIsSettingsOpen(true)}
                className="ml-2 p-2 bg-gray-700 hover:bg-gray-600 text-white rounded-lg transition-colors"
                title="Configurações"
              >
                <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    strokeWidth={2}
                    d="M10.325 4.317c.426-1.756 2.924-1.756 3.35 0a1.724 1.724 0 002.573 1.066c1.543-.94 3.31.826 2.37 2.37a1.724 1.724 0 001.065 2.572c1.756.426 1.756 2.924 0 3.35a1.724 1.724 0 00-1.066 2.573c.94 1.543-.826 3.31-2.37 2.37a1.724 1.724 0 00-2.572 1.065c-.426 1.756-2.924 1.756-3.35 0a1.724 1.724 0 00-2.573-1.066c-1.543.94-3.31-.826-2.37-2.37a1.724 1.724 0 00-1.065-2.572c-1.756-.426-1.756-2.924 0-3.35a1.724 1.724 0 001.066-2.573c-.94-1.543.826-3.31 2.37-2.37.996.608 2.296.07 2.572-1.065z"
                  />
                  <path
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    strokeWidth={2}
                    d="M15 12a3 3 0 11-6 0 3 3 0 016 0z"
                  />
                </svg>
              </button>
            </div>
          </div>

          {/* Current transcript */}
          {currentTranscript && (
            <p className="text-white/50 text-xs mt-2 truncate">{currentTranscript}</p>
          )}
        </div>
      </div>

      {/* Right side - Conversation */}
      <div className="w-96 bg-gray-900/80 border-l border-white/10 flex flex-col">
        {/* Header */}
        <div className="p-4 border-b border-white/10">
          <h3 className="text-white font-semibold">Conversa</h3>
          <p className="text-gray-500 text-xs">
            {identifiedPerson ? identifiedPerson.name : "Aguardando pessoa..."}
          </p>
        </div>

        {/* Messages */}
        <div className="flex-1 overflow-y-auto p-4 space-y-3">
          {messages.length === 0 ? (
            <div className="flex items-center justify-center h-full">
              <p className="text-gray-600 text-sm text-center">
                As mensagens aparecerão aqui
              </p>
            </div>
          ) : (
            messages.map((msg) => (
              <div
                key={msg.id}
                className={`flex ${msg.role === "user" ? "justify-end" : "justify-start"}`}
              >
                <div
                  className={`max-w-[85%] rounded-2xl px-4 py-2 ${
                    msg.role === "user"
                      ? "bg-blue-600 text-white rounded-br-md"
                      : "bg-gray-700 text-white rounded-bl-md"
                  }`}
                >
                  <p className="text-sm">{msg.content}</p>
                  <p className="text-[10px] opacity-50 mt-1">
                    {msg.timestamp.toLocaleTimeString("pt-BR", {
                      hour: "2-digit",
                      minute: "2-digit",
                    })}
                  </p>
                </div>
              </div>
            ))
          )}
          <div ref={messagesEndRef} />
        </div>

        {/* Footer info */}
        <div className="p-3 border-t border-white/10 bg-black/30">
          <p className="text-gray-500 text-xs text-center">
            {messages.length} mensagens
          </p>
        </div>
      </div>

      {/* Settings Panel */}
      <SettingsPanel
        isOpen={isSettingsOpen}
        onClose={() => setIsSettingsOpen(false)}
        settings={settings}
        onSettingsChange={handleSettingsChange}
      />
    </div>
  );
}

/**
 * Face detection overlay - draws bounding box and name label.
 */
function FaceOverlay({
  faceBox,
  videoWidth,
  videoHeight,
  personName,
}: {
  faceBox: FaceBox;
  videoWidth: number;
  videoHeight: number;
  personName: string | null;
}) {
  // Calculate percentages for positioning (video is mirrored, so we flip x)
  const left = ((videoWidth - faceBox.x - faceBox.width) / videoWidth) * 100;
  const top = (faceBox.y / videoHeight) * 100;
  const width = (faceBox.width / videoWidth) * 100;
  const height = (faceBox.height / videoHeight) * 100;

  const isKnown = !!personName;
  const borderColor = isKnown ? "border-green-500" : "border-yellow-500";
  const bgColor = isKnown ? "bg-green-600" : "bg-yellow-600";

  return (
    <div
      className={`absolute pointer-events-none ${borderColor} border-3 rounded-lg`}
      style={{
        left: `${left}%`,
        top: `${top}%`,
        width: `${width}%`,
        height: `${height}%`,
        borderWidth: "3px",
      }}
    >
      {/* Name label above the box */}
      <div
        className={`absolute -top-8 left-1/2 -translate-x-1/2 ${bgColor} px-3 py-1 rounded-md whitespace-nowrap`}
      >
        <span className="text-white text-sm font-semibold">
          {personName ?? "Desconhecido"}
        </span>
      </div>

      {/* Corner indicators */}
      <div className={`absolute -top-1 -left-1 w-4 h-4 border-t-4 border-l-4 ${borderColor} rounded-tl-lg`} />
      <div className={`absolute -top-1 -right-1 w-4 h-4 border-t-4 border-r-4 ${borderColor} rounded-tr-lg`} />
      <div className={`absolute -bottom-1 -left-1 w-4 h-4 border-b-4 border-l-4 ${borderColor} rounded-bl-lg`} />
      <div className={`absolute -bottom-1 -right-1 w-4 h-4 border-b-4 border-r-4 ${borderColor} rounded-br-lg`} />
    </div>
  );
}
