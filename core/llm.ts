import Anthropic from "@anthropic-ai/sdk";
import AnthropicBedrock from "@anthropic-ai/bedrock-sdk";
import AnthropicVertex from "@anthropic-ai/vertex-sdk";
import { GoogleGenAI } from "@google/genai";

export type ModelTier = "fast" | "powerful";

type Backend = "bedrock" | "vertex" | "gemini" | "api";

// Anthropic-compatible clients (Bedrock, Vertex, direct API)
type AnthropicClient = Anthropic | AnthropicBedrock | AnthropicVertex;

let anthropicClient: AnthropicClient | null = null;
let geminiClient: GoogleGenAI | null = null;
let backend: Backend | null = null;

function anthropicModelId(tier: ModelTier): string {
  switch (backend) {
    case "bedrock": {
      const prefix = process.env.BEDROCK_PREFIX ?? "us";
      return tier === "powerful"
        ? `${prefix}.anthropic.claude-opus-4-6-v1`
        : `${prefix}.anthropic.claude-sonnet-4-6`;
    }
    case "vertex":
      return tier === "powerful"
        ? "claude-opus-4-6"
        : "claude-sonnet-4-6";
    default:
      return tier === "powerful"
        ? "claude-opus-4-6-20250715"
        : "claude-sonnet-4-6-20250514";
  }
}

function geminiModelId(tier: ModelTier): string {
  return tier === "powerful" ? "gemini-2.5-pro" : "gemini-2.5-flash";
}

/**
 * Resolve backend from environment.
 *
 * Priority:
 *   1. ANTHROPIC_API_KEY → direct Anthropic API
 *   2. GOOGLE_GENAI_API_KEY → Gemini direct API
 *   3. TOWER_BACKEND=vertex → Vertex AI (Claude)
 *   4. TOWER_BACKEND=gemini → Vertex AI (Gemini)
 *   5. Default → AWS Bedrock
 */
function resolveBackend(): void {
  if (backend) return;

  const explicit = process.env.TOWER_BACKEND?.toLowerCase();

  // Explicit backend override
  if (explicit === "vertex") {
    const opts: Record<string, string> = {
      region: process.env.GOOGLE_CLOUD_REGION ?? "us-east5",
    };
    if (process.env.GOOGLE_CLOUD_PROJECT) opts.projectId = process.env.GOOGLE_CLOUD_PROJECT;
    anthropicClient = new AnthropicVertex(opts);
    backend = "vertex";
    console.error("tower: using Vertex AI (Claude)");
    return;
  }

  if (explicit === "gemini") {
    geminiClient = new GoogleGenAI({
      vertexai: true,
      project: process.env.GOOGLE_CLOUD_PROJECT,
      location: process.env.GOOGLE_CLOUD_REGION ?? "us-east5",
    });
    backend = "gemini";
    console.error("tower: using Vertex AI (Gemini)");
    return;
  }

  // Auto-detect from credentials
  if (process.env.ANTHROPIC_API_KEY) {
    anthropicClient = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
    backend = "api";
    console.error("tower: using Anthropic API");
    return;
  }

  if (process.env.GOOGLE_GENAI_API_KEY) {
    geminiClient = new GoogleGenAI({ apiKey: process.env.GOOGLE_GENAI_API_KEY });
    backend = "gemini";
    console.error("tower: using Gemini API");
    return;
  }

  if (process.env.GOOGLE_CLOUD_PROJECT) {
    // GCP project set — use Vertex AI with Claude by default
    const opts: Record<string, string> = {
      projectId: process.env.GOOGLE_CLOUD_PROJECT,
      region: process.env.GOOGLE_CLOUD_REGION ?? "us-east5",
    };
    anthropicClient = new AnthropicVertex(opts);
    backend = "vertex";
    console.error("tower: using Vertex AI (Claude)");
    return;
  }

  // Default: Bedrock
  const bedrockOpts: Record<string, string> = {};
  const region = process.env.AWS_REGION;
  if (region) bedrockOpts.awsRegion = region;
  anthropicClient = new AnthropicBedrock(bedrockOpts);
  backend = "bedrock";
  console.error("tower: using AWS Bedrock");
}

export interface ChatMessage {
  role: "user" | "assistant";
  content: string;
}

export async function chat(
  messages: ChatMessage[],
  options: {
    system?: string;
    tier?: ModelTier;
    maxTokens?: number;
  } = {}
): Promise<string> {
  resolveBackend();
  const { system, tier = "fast", maxTokens = 8192 } = options;

  if (backend === "gemini") {
    return chatGemini(messages, { system, tier, maxTokens });
  }

  return chatAnthropic(messages, { system, tier, maxTokens });
}

async function chatAnthropic(
  messages: ChatMessage[],
  options: { system?: string; tier: ModelTier; maxTokens: number }
): Promise<string> {
  const client = anthropicClient!;
  const { system, tier, maxTokens } = options;

  const response = await client.messages.create({
    model: anthropicModelId(tier),
    max_tokens: maxTokens,
    system: system ?? "",
    messages,
  });

  const textBlocks = response.content.filter(
    (b): b is Anthropic.TextBlock => b.type === "text"
  );
  return textBlocks.map((b) => b.text).join("");
}

async function chatGemini(
  messages: ChatMessage[],
  options: { system?: string; tier: ModelTier; maxTokens: number }
): Promise<string> {
  const client = geminiClient!;
  const { system, tier, maxTokens } = options;

  // Convert to Gemini format: combine system + messages into contents
  const contents = messages.map((m) => ({
    role: m.role === "assistant" ? ("model" as const) : ("user" as const),
    parts: [{ text: m.content }],
  }));

  const response = await client.models.generateContent({
    model: geminiModelId(tier),
    config: {
      maxOutputTokens: maxTokens,
      systemInstruction: system,
    },
    contents,
  });

  return response.text ?? "";
}

/** Reset client (for testing) */
export function resetClient(): void {
  anthropicClient = null;
  geminiClient = null;
  backend = null;
}
