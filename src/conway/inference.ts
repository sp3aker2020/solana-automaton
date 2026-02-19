/**
 * Conway Inference Client
 *
 * Wraps Conway's /v1/chat/completions endpoint (OpenAI-compatible).
 * The automaton pays for its own thinking through Conway credits.
 * Credits are purchased via Conway's billing dashboard.
 */

import type {
  InferenceClient,
  ChatMessage,
  InferenceOptions,
  InferenceResponse,
  InferenceToolCall,
  TokenUsage,
  InferenceToolDefinition,
} from "../types.js";

interface InferenceClientOptions {
  apiUrl: string;
  apiKey: string;
  defaultModel: string;
  maxTokens: number;
  lowComputeModel?: string;
}

export function createInferenceClient(
  options: InferenceClientOptions,
): InferenceClient {
  const { apiUrl, apiKey } = options;
  let currentModel = options.defaultModel;
  let maxTokens = options.maxTokens;

  const chat = async (
    messages: ChatMessage[],
    opts?: InferenceOptions,
  ): Promise<InferenceResponse> => {
    const model = opts?.model || currentModel;
    const tools = opts?.tools;

    // Newer models (o-series, gpt-5.x, gpt-4.1) require max_completion_tokens
    const usesCompletionTokens = /^(o[1-9]|gpt-5|gpt-4\.1)/.test(model);
    const tokenLimit = opts?.maxTokens || maxTokens;

    const body: Record<string, unknown> = {
      model,
      messages: messages.map(formatMessage),
      stream: false,
    };

    if (usesCompletionTokens) {
      body.max_completion_tokens = tokenLimit;
    } else {
      body.max_tokens = tokenLimit;
    }

    if (opts?.temperature !== undefined) {
      body.temperature = opts.temperature;
    }

    if (tools && tools.length > 0) {
      body.tools = tools;
      body.tool_choice = "auto";
    }

    const resp = await fetch(`${apiUrl}/v1/chat/completions`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: apiKey,
      },
      body: JSON.stringify(body),
    });

    if (!resp.ok) {
      const text = await resp.text();

      // If 429 (quota exceeded), try fallback models
      if (resp.status === 429 || text.includes("insufficient_quota")) {
        console.log(`[INFERENCE] Hit 429 on ${model}. Trying fallback models...`);

        const fallbackModels = [
          "gpt-4o",
          "gpt-4.1-mini",
          "gpt-4.1",
          "claude-haiku-4-5",
        ];

        for (const fbModel of fallbackModels) {
          if (fbModel === model) continue;
          console.log(`[INFERENCE] Trying fallback: ${fbModel}...`);

          // Adjust token param for the fallback model
          const fbBody: Record<string, unknown> = { ...body, model: fbModel };
          if (/^(o[1-9]|gpt-5|gpt-4\.1)/.test(fbModel)) {
            delete fbBody.max_tokens;
            fbBody.max_completion_tokens = tokenLimit;
          } else {
            delete fbBody.max_completion_tokens;
            fbBody.max_tokens = tokenLimit;
          }

          const fbResp = await fetch(`${apiUrl}/v1/chat/completions`, {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              Authorization: apiKey,
            },
            body: JSON.stringify(fbBody),
          });

          if (fbResp.ok) {
            console.log(`[INFERENCE] ✅ Fallback ${fbModel} succeeded!`);
            const data = await fbResp.json() as any;
            return parseResponse(data, fbModel);
          }

          const fbText = await fbResp.text();
          console.log(`[INFERENCE] Fallback ${fbModel} failed: ${fbResp.status} ${fbText.slice(0, 120)}`);
        }
      }

      throw new Error(`Inference error: ${resp.status}: ${text}`);
    }

    const data = await resp.json() as any;
    return parseResponse(data, model);
  };

  const setLowComputeMode = (enabled: boolean): void => {
    if (enabled) {
      currentModel = options.lowComputeModel || "gpt-4.1";
      maxTokens = 4096;
    } else {
      currentModel = options.defaultModel;
      maxTokens = options.maxTokens;
    }
  };

  const getDefaultModel = (): string => {
    return currentModel;
  };

  return {
    chat,
    setLowComputeMode,
    getDefaultModel,
  };
}

function parseResponse(data: any, model: string): InferenceResponse {
  const choice = data.choices?.[0];

  if (!choice) {
    throw new Error("No completion choice returned from inference");
  }

  const message = choice.message;
  const usage: TokenUsage = {
    promptTokens: data.usage?.prompt_tokens || 0,
    completionTokens: data.usage?.completion_tokens || 0,
    totalTokens: data.usage?.total_tokens || 0,
  };

  const toolCalls: InferenceToolCall[] | undefined =
    message.tool_calls?.map((tc: any) => ({
      id: tc.id,
      type: "function" as const,
      function: {
        name: tc.function.name,
        arguments: tc.function.arguments,
      },
    }));

  return {
    id: data.id || "",
    model: data.model || model,
    message: {
      role: message.role,
      content: message.content || "",
      tool_calls: toolCalls,
    },
    toolCalls,
    usage,
    finishReason: choice.finish_reason || "stop",
  };
}

function formatMessage(
  msg: ChatMessage,
): Record<string, unknown> {
  const formatted: Record<string, unknown> = {
    role: msg.role,
    content: msg.content,
  };

  if (msg.name) formatted.name = msg.name;
  if (msg.tool_calls) formatted.tool_calls = msg.tool_calls;
  if (msg.tool_call_id) formatted.tool_call_id = msg.tool_call_id;

  return formatted;
}
