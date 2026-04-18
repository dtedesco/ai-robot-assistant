import type { AgentToolsConfig } from "@robot/shared";

/**
 * OpenAI Realtime tool schemas. These are passed into `session.update` when the
 * realtime session is configured, and referenced by name when tool_call events
 * come back from OpenAI.
 */
export interface RealtimeToolSchema {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
}

export const TOOL_SHOW_ON_TV: RealtimeToolSchema = {
  name: "show_on_tv",
  description:
    "Shows arbitrary content on the TV synced with the agent's speech. Use when the user asks for something visual.",
  parameters: {
    type: "object",
    properties: {
      kind: {
        type: "string",
        enum: ["youtube", "image", "webpage", "text"],
        description: "Kind of content to display.",
      },
      url: {
        type: "string",
        description:
          "URL of the content (required for youtube/image/webpage).",
      },
      text: {
        type: "string",
        description: "Plain text to display (required when kind=text).",
      },
      title: {
        type: "string",
        description: "Optional title shown as caption.",
      },
    },
    required: ["kind"],
  },
};

export const TOOL_SHOW_FROM_LIBRARY: RealtimeToolSchema = {
  name: "show_from_library",
  description:
    "Displays a pre-curated item from the agent's TV library matching the given topic.",
  parameters: {
    type: "object",
    properties: {
      topic: {
        type: "string",
        description: "Topic name registered in the agent library.",
      },
    },
    required: ["topic"],
  },
};

export const TOOL_CLEAR_TV: RealtimeToolSchema = {
  name: "clear_tv",
  description: "Clears the TV.",
  parameters: { type: "object", properties: {} },
};

export const TOOL_ROBOT_DANCE: RealtimeToolSchema = {
  name: "robot_dance",
  description:
    "Triggers a body animation on the robot. action is an integer 1-93.",
  parameters: {
    type: "object",
    properties: {
      action: {
        type: "integer",
        minimum: 1,
        maximum: 93,
        description: "Dance action id.",
      },
    },
    required: ["action"],
  },
};

export const TOOL_ROBOT_COLOR: RealtimeToolSchema = {
  name: "robot_color",
  description:
    "Changes the color of the robot eyes. color is 1=darkblue, 2=blue, 3=green, 4=yellow, 5=red, 6=purple, 7=white.",
  parameters: {
    type: "object",
    properties: {
      color: {
        type: "integer",
        minimum: 1,
        maximum: 7,
        description: "Color code.",
      },
    },
    required: ["color"],
  },
};

/** All tools keyed by name for lookup when OpenAI emits `response.function_call`. */
export const ALL_TOOLS: Record<string, RealtimeToolSchema> = {
  show_on_tv: TOOL_SHOW_ON_TV,
  show_from_library: TOOL_SHOW_FROM_LIBRARY,
  clear_tv: TOOL_CLEAR_TV,
  robot_dance: TOOL_ROBOT_DANCE,
  robot_color: TOOL_ROBOT_COLOR,
};

/** Build the tool list, filtered by what the agent has enabled. */
export function buildEnabledTools(
  config: AgentToolsConfig,
): RealtimeToolSchema[] {
  const tools: RealtimeToolSchema[] = [];
  if (config.showOnTv) tools.push(TOOL_SHOW_ON_TV);
  if (config.showFromLibrary) tools.push(TOOL_SHOW_FROM_LIBRARY);
  if (config.clearTv) tools.push(TOOL_CLEAR_TV);
  if (config.robotDance) tools.push(TOOL_ROBOT_DANCE);
  if (config.robotColor) tools.push(TOOL_ROBOT_COLOR);
  return tools;
}
