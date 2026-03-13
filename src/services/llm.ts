import { GeoResult } from "./ncbi";

const SAIA_MODELS = [
  "devstral-2-123b-instruct-2512",
  "glm-4.7",
  "qwen3-omni-30b-a3b-instruct",
  "deepseek-r1-distill-llama-70b",
];

const OPENROUTER_MODELS = [
  "stepfun/step-3.5-flash:free",
  "google/gemini-3.1-flash-lite-preview",
  "z-ai/glm-4.5-air:free",
  "openai/gpt-oss-120b:free",
  "qwen/qwen3-next-80b-a3b-instruct:free",
  "google/gemma-3-27b-it:free",
];

type Provider = "saia" | "openrouter";

async function callChatViaProxy(
  provider: Provider,
  apiKey: string,
  body: any,
  signal?: AbortSignal,
  timeoutMs: number = 30000
) {
  const timeoutController = new AbortController();
  const timeoutId = setTimeout(() => timeoutController.abort(), timeoutMs);

  const onAbort = () => timeoutController.abort();
  if (signal) signal.addEventListener("abort", onAbort);

  try {
    const response = await fetch("/api/llm/chat", {
      method: "POST",
      headers: {
        Accept: "application/json",
        "Content-Type": "application/json",
        "x-provider": provider,
        "x-api-key": apiKey,
      },
      body: JSON.stringify(body),
      signal: timeoutController.signal,
    });

    if (!response.ok) {
      const errText = await response.text().catch(() => "");
      throw new Error(`HTTP ${response.status} from ${provider}: ${errText}`);
    }

    return await response.json();
  } catch (error: any) {
    if (error?.name === "AbortError") {
      if (signal?.aborted) throw new Error("Aborted by user");
      throw new Error(`Provider ${provider} timed out after ${Math.round(timeoutMs / 1000)}s.`);
    }
    throw error;
  } finally {
    clearTimeout(timeoutId);
    if (signal) signal.removeEventListener("abort", onAbort);
  }
}

function parseJsonFromModelText(text: string) {
  const jsonMatch = text.match(/\{[\s\S]*\}/);
  const candidate = jsonMatch ? jsonMatch[0] : text;

  let parsed: any;
  try {
    parsed = JSON.parse(candidate);
  } catch {
    throw new Error(`Invalid JSON structure returned: ${candidate.substring(0, 200)}...`);
  }

  const score =
    typeof parsed.score === "number" ? parsed.score : parseInt(String(parsed.score ?? ""), 10);

  if (!parsed.decision || Number.isNaN(score)) {
    throw new Error(`Missing required fields in JSON: ${candidate.substring(0, 200)}...`);
  }

  return {
    decision: parsed.decision as "include" | "exclude" | "unclear",
    score,
    reasoning: (parsed.reasoning ?? "No reasoning provided.") as string,
    tags: (parsed.tags ?? []) as string[],
  };
}

export type LlmKeys = {
  saiaApiKey?: string;
  openRouterApiKey?: string;
};

export type LlmStrategy = "saia_only" | "openrouter_only" | "saia_then_openrouter" | "openrouter_then_saia";

export async function evaluateDataset(
  dataset: GeoResult,
  userPrompt: string,
  expectedTags: string,
  keys: LlmKeys,
  signal?: AbortSignal,
  onLog?: (msg: string) => void,
  strategy: LlmStrategy = "saia_then_openrouter"
): Promise<Partial<GeoResult>> {
  const saiaKey = (keys.saiaApiKey ?? "").trim();
  const orKey = (keys.openRouterApiKey ?? "").trim();

  if (!saiaKey && !orKey) {
    throw new Error("Missing API key(s). Please provide a SAIA key and/or an OpenRouter key.");
  }

  const prompt = `
You are an expert bioinformatician evaluating NCBI GEO datasets.

Dataset Metadata:
Title: ${dataset.title}
Summary: ${dataset.summary}
Overall Design: ${dataset.overallDesign || "Not available"}
Organism: ${dataset.organism}
Assay Type: ${dataset.assay}
Samples: ${dataset.n_samples}
Paper Abstract/Methods: ${dataset.paperAbstract || "Not available"}
FTP Link (Proxy for Filenames): ${dataset.ftpLink || "Not available"}

User Intent / Criteria:
${userPrompt}

Expected Tags to choose from (you can add others if highly relevant, but prefer these):
${expectedTags}

Evaluate this dataset based on the User Intent.
Return ONLY a valid JSON object (no markdown formatting, no backticks) with this exact structure:
{
  "decision": "include" | "exclude" | "unclear",
  "score": number (0-100),
  "reasoning": "string (cite metadata)",
  "tags": ["tag1", "tag2"]
}
`;

  let lastError: Error | null = null;

  const providerOrder: Provider[] =
    strategy === "saia_only"
      ? ["saia"]
      : strategy === "openrouter_only"
        ? ["openrouter"]
        : strategy === "openrouter_then_saia"
          ? ["openrouter", "saia"]
          : ["saia", "openrouter"]; // default

  for (const provider of providerOrder) {
    const apiKey = provider === "saia" ? saiaKey : orKey;
    if (!apiKey) {
      onLog?.(`${provider.toUpperCase()} skipped (no API key provided).`);
      continue;
    }

    const models = provider === "saia" ? SAIA_MODELS : OPENROUTER_MODELS;

    for (const model of models) {
      if (signal?.aborted) throw new Error("Aborted by user");

      try {
        const data = await callChatViaProxy(
          provider,
          apiKey,
          {
            model,
            messages: [
              {
                role: "system",
                content:
                  "You are a strict JSON-only API. You must output raw JSON without markdown formatting.",
              },
              { role: "user", content: prompt },
            ],
            temperature: 0,
            ...(provider === "openrouter" ? { response_format: { type: "json_object" } } : {}),
          },
          signal,
          30000
        );

        const text = data.choices?.[0]?.message?.content || "";
        const modelUsed = data.model || model;

        const parsed = parseJsonFromModelText(text);

        return {
          llmDecision: parsed.decision,
          llmScore: parsed.score,
          llmReasoning: parsed.reasoning,
          llmTags: parsed.tags,
          llmModelUsed: `${provider}:${modelUsed}`,
        };
      } catch (error: any) {
        if (error?.message === "Aborted by user") throw error;
        lastError = error instanceof Error ? error : new Error(String(error));
        onLog?.(`${provider.toUpperCase()} model ${model} failed: ${lastError.message}`);
      }
    }
  }

  onLog?.("All providers/models in fallback hierarchy failed.");
  return {
    llmDecision: "unclear",
    llmScore: 0,
    llmReasoning: `Failed to evaluate. Last error: ${lastError?.message ?? "unknown"}`,
    llmTags: ["error"],
    llmModelUsed: "None",
  };
}