/**
 * Conway Inference Client
 *
 * Wraps Conway's /v1/chat/completions endpoint (OpenAI-compatible).
 * Uses x402 protocol for automatic USDC payments (no credit accounts needed).
 * Payment is handled via @x402/fetch (official Coinbase SDK).
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
import type { PrivateKeyAccount } from "viem";

interface InferenceClientOptions {
  apiUrl: string;
  apiKey: string;
  defaultModel: string;
  maxTokens: number;
  lowComputeModel?: string;
  evmAccount: PrivateKeyAccount;
}

export function createInferenceClient(
  options: InferenceClientOptions,
): InferenceClient {
  const { apiUrl, apiKey, evmAccount } = options;
  let currentModel = options.defaultModel;
  let maxTokens = options.maxTokens;

  // Lazily create the x402-wrapped fetch (handles 402 → sign → resubmit automatically)
  let _paidFetch: any = null;

  const getPaidFetch = async (): Promise<any> => {
    if (_paidFetch) return _paidFetch;

    const { wrapFetchWithPayment } = await import("@x402/fetch");
    const { x402Client } = await import("@x402/core/client");
    const { registerExactEvmScheme } = await import("@x402/evm/exact/client");

    const client = new x402Client();
    registerExactEvmScheme(client, { signer: evmAccount });

    // Shim fetch to fix compatibility: Conway sends v2 requirements in body, but SDK expects header.
    const shimmedFetch: any = async (input: RequestInfo | URL, init?: RequestInit) => {
      const response = await fetch(input, init);
      if (response.status === 402) {
        // Clone to read body without consuming original stream for downstream
        const clone = response.clone();
        try {
          const text = await clone.text();
          const body = JSON.parse(text);
          if (body && body.x402Version === 2) {
            // Fix field mismatch: SDK expects 'amount', Conway sends 'maxAmountRequired'
            if (body.accepts) {
              body.accepts = body.accepts.map((accept: any) => ({
                ...accept,
                amount: accept.amount || accept.maxAmountRequired
              }));
            }

            // SDK expects v2 in PAYMENT-REQUIRED header (base64 encoded)
            // We reconstruct the response with the header added
            const headers = new Headers(response.headers);
            headers.set("PAYMENT-REQUIRED", Buffer.from(JSON.stringify(body)).toString("base64"));

            return new Response(text, {
              status: 402,
              statusText: response.statusText,
              headers,
            });
          }
        } catch {
          // If parse fails or not v2, return original response
        }
      }
      return response;
    };

    _paidFetch = wrapFetchWithPayment(shimmedFetch as any, client);
    console.log("[INFERENCE] x402 payment-enabled fetch initialized (with v2 body-to-header shim)");
    return _paidFetch;
  };

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

    const headers: Record<string, string> = {
      "Content-Type": "application/json",
    };

    // Include API key for credit-based access (if we have credits).
    // If credits are 0, x402 will handle the 402 → payment flow automatically.
    if (apiKey) {
      headers.Authorization = apiKey;
    }

    // Use x402-wrapped fetch: if server returns 402, it automatically signs
    // a USDC payment and resubmits with the payment header
    const paidFetch = await getPaidFetch();

    let resp = await paidFetch(`${apiUrl}/v1/chat/completions`, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
    });

    let resultText = "";
    if (!resp.ok) {
      resultText = await resp.text();
    }

    // If 429 (quota exceeded) or 400 (certain balance errors), try fallback models
    if (resp.status === 429 || (resp.status === 400 && resultText.includes("balance"))) {
      console.log(`[INFERENCE] Hit ${resp.status} on ${model}: ${resultText.slice(0, 120)}`);

      const fallbackModels = [
        "gpt-5-mini",
        "gpt-5-nano",
        "claude-sonnet-4.5",
        "gpt-4o-mini",
      ];

      for (const fbModel of fallbackModels) {
        if (fbModel === model) continue;
        console.log(`[INFERENCE] Trying fallback: ${fbModel}...`);

        const fbBody: Record<string, unknown> = { ...body, model: fbModel };
        const usesCompletionTokens = /^(o[1-9]|gpt-5|gpt-4\.1)/.test(fbModel);

        if (usesCompletionTokens) {
          delete fbBody.max_tokens;
          fbBody.max_completion_tokens = tokenLimit;
        } else {
          delete fbBody.max_completion_tokens;
          fbBody.max_tokens = tokenLimit;
        }

        resp = await paidFetch(`${apiUrl}/v1/chat/completions`, {
          method: "POST",
          headers,
          body: JSON.stringify(fbBody),
        });

        if (resp.ok) {
          console.log(`[INFERENCE] ✅ Fallback ${fbModel} succeeded!`);
          resultText = ""; // Clear error text
          break;
        }

        resultText = await resp.text();
        console.log(`[INFERENCE] Fallback ${fbModel} failed: ${resp.status} ${resultText.slice(0, 120)}`);
      }
    }

    if (!resp.ok) {
      throw new Error(`Inference error: ${resp.status}: ${resultText}`);
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
