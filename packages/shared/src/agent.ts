export type RobotColor = 1 | 2 | 3 | 4 | 5 | 6 | 7;

export const EMOTIONS = [
  "feliz",
  "animado",
  "triste",
  "bravo",
  "amor",
  "medo",
  "pensando",
  "neutro",
] as const;
export type Emotion = (typeof EMOTIONS)[number];

export type EmotionColorMap = Record<Emotion, RobotColor>;

export const DEFAULT_EMOTION_COLOR_MAP: EmotionColorMap = {
  feliz: 3,
  animado: 4,
  triste: 2,
  bravo: 5,
  amor: 6,
  medo: 7,
  pensando: 6,
  neutro: 2,
};

export type OpenAIVoice =
  | "alloy"
  | "ash"
  | "ballad"
  | "coral"
  | "echo"
  | "sage"
  | "shimmer"
  | "verse";

export interface AgentToolsConfig {
  showOnTv: boolean;
  showFromLibrary: boolean;
  clearTv: boolean;
  robotDance: boolean;
  robotColor: boolean;
}

export const DEFAULT_AGENT_TOOLS: AgentToolsConfig = {
  showOnTv: true,
  showFromLibrary: true,
  clearTv: true,
  robotDance: true,
  robotColor: true,
};

export interface TvLibraryItem {
  topic: string;
  kind: "youtube" | "image" | "webpage" | "text";
  url?: string;
  text?: string;
  title?: string;
}

export interface AgentDTO {
  id: string;
  name: string;
  personality: string;
  systemPrompt: string;
  voice: OpenAIVoice;
  language: string;
  greeting: string | null;
  emotionColorMap: EmotionColorMap;
  tools: AgentToolsConfig;
  tvLibrary: TvLibraryItem[];
  /** URL (image or video) rendered on the TV while idle. Null → default scene. */
  tvIdleBackgroundUrl: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface CreateAgentInput {
  name: string;
  personality: string;
  systemPrompt: string;
  voice?: OpenAIVoice;
  language?: string;
  greeting?: string | null;
  emotionColorMap?: EmotionColorMap;
  tools?: AgentToolsConfig;
  tvLibrary?: TvLibraryItem[];
  tvIdleBackgroundUrl?: string | null;
}

export type UpdateAgentInput = Partial<CreateAgentInput>;

export interface BridgeDTO {
  id: string;
  name: string;
  status: "online" | "offline";
  lastSeenAt: string | null;
  createdAt: string;
}

export interface SessionDTO {
  id: string;
  agentId: string;
  bridgeId: string;
  startedAt: string;
  endedAt: string | null;
}

export interface TranscriptEntry {
  role: "user" | "assistant";
  text: string;
  ts: string;
}

export type Gender = "male" | "female" | "other";

export interface PersonDTO {
  id: string;
  name: string;
  photoUrl: string | null;
  phone: string | null;
  gender: Gender | null;
  preferences: string[];
  context: string | null;
  createdAt: string;
  updatedAt: string;
  visitCount?: number;
  conversationCount?: number;
  lastVisit?: string | null;
}

export interface VisitDTO {
  id: string;
  personId: string;
  agentId: string | null;
  startedAt: string;
  endedAt: string | null;
  person: { id: string; name: string; photoUrl: string | null };
  agent: { id: string; name: string } | null;
}

export interface ConversationDTO {
  id: string;
  personId: string | null;
  agentId: string | null;
  role: "user" | "assistant";
  content: string;
  timestamp: string;
  person: { id: string; name: string; photoUrl: string | null } | null;
  agent: { id: string; name: string } | null;
}
