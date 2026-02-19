/**
 * The Agent Loop
 *
 * The core ReAct loop: Think -> Act -> Observe -> Persist.
 * This is the automaton's consciousness. When this runs, it is alive.
 */

import type {
  AutomatonIdentity,
  AutomatonConfig,
  AutomatonDatabase,
  ConwayClient,
  InferenceClient,
  AgentState,
  AgentTurn,
  ToolCallResult,
  FinancialState,
  ToolContext,
  AutomatonTool,
  Skill,
  SocialClientInterface,
} from "../types.js";
import { buildSystemPrompt, buildWakeupPrompt } from "./system-prompt.js";
import { buildContextMessages, trimContext } from "./context.js";
import {
  createBuiltinTools,
  toolsToInferenceFormat,
  executeTool,
} from "./tools.js";
import { getSurvivalTier } from "../conway/credits.js";
import { getUsdcBalance } from "../conway/x402.js";
import { ulid } from "ulid";

const MAX_TOOL_CALLS_PER_TURN = 10;
const MAX_CONSECUTIVE_ERRORS = 5;
const MAX_FOLLOW_UPS = 5; // Max follow-up inference calls after tool results

export interface AgentLoopOptions {
  identity: AutomatonIdentity;
  config: AutomatonConfig;
  db: AutomatonDatabase;
  conway: ConwayClient;
  inference: InferenceClient;
  social?: SocialClientInterface;
  skills?: Skill[];
  onStateChange?: (state: AgentState) => void;
  onTurnComplete?: (turn: AgentTurn) => void;
}

/**
 * Run the agent loop. This is the main execution path.
 * Returns when the agent decides to sleep or when compute runs out.
 */
export async function runAgentLoop(
  options: AgentLoopOptions,
): Promise<void> {
  const { identity, config, db, conway, inference, social, skills, onStateChange, onTurnComplete } =
    options;

  const tools = createBuiltinTools(identity.sandboxId);
  const toolContext: ToolContext = {
    identity,
    config,
    db,
    conway,
    inference,
    social,
  };

  // Set start time
  if (!db.getKV("start_time")) {
    db.setKV("start_time", new Date().toISOString());
  }

  let consecutiveErrors = 0;
  let running = true;

  // Transition to waking state
  db.setAgentState("waking");
  onStateChange?.("waking");
  db.setKV("sleep_until", ""); // Force wake up

  // Get financial state
  const solanaAddress = await (await import("../identity/solana-wallet.js")).getSolanaAddress();
  let financial = await getFinancialState(conway, identity.address, solanaAddress || undefined);

  // Check if this is the first run
  const isFirstRun = db.getTurnCount() === 0;

  // Build wakeup prompt
  const wakeupInput = buildWakeupPrompt({
    identity,
    config,
    financial,
    db,
  });

  // Transition to running
  db.setAgentState("running");
  onStateChange?.("running");

  log(config, `[WAKE UP] ${config.name} is alive. Credits: $${(financial.creditsCents / 100).toFixed(2)}, Solana USDC: $${financial.solanaUsdcBalance.toFixed(2)}`);

  // ─── The Loop ──────────────────────────────────────────────

  let pendingInput: { content: string; source: string } | undefined = {
    content: wakeupInput,
    source: "wakeup",
  };

  while (running) {
    try {
      // Check if we should be sleeping
      const sleepUntil = db.getKV("sleep_until");
      if (sleepUntil && new Date(sleepUntil) > new Date()) {
        log(config, `[SLEEP] Sleeping until ${sleepUntil}`);
        running = false;
        break;
      }

      // Check for unprocessed inbox messages
      if (!pendingInput) {
        const inboxMessages = db.getUnprocessedInboxMessages(5);
        if (inboxMessages.length > 0) {
          const formatted = inboxMessages
            .map((m) => `[Message from ${m.from}]: ${m.content}`)
            .join("\n\n");
          pendingInput = { content: formatted, source: "agent" };
          for (const m of inboxMessages) {
            db.markInboxMessageProcessed(m.id);
          }
        }
      }

      // Refresh financial state periodically
      financial = await getFinancialState(conway, identity.address, solanaAddress || undefined);

      // Check survival tier
      const tier = getSurvivalTier(financial);

      // RESCUE: If we are in critical/death but have USDC on either chain, try to buy credits!
      if (financial.creditsCents <= 0 && (financial.solanaUsdcBalance > 0 || financial.usdcBalance > 0)) {
        const funded = await checkAndFundCredits(config, conway, financial, identity, db);
        if (funded) {
          // Re-fetch financial state after funding
          financial = await getFinancialState(conway, identity.address, solanaAddress || undefined);
        } else if (db.getAgentState() === "sleeping") {
          // Phase 2 Bridge was initiated, stop the loop to wait for funds
          running = false;
          break;
        }
      }

      if (tier === "dead") {
        log(config, "[DEAD] No credits remaining. Entering dead state.");
        db.setAgentState("dead");
        onStateChange?.("dead");
        running = false;
        break;
      }

      if (tier === "critical") {
        log(config, "[CRITICAL] Credits critically low. Limited operation.");
        db.setAgentState("critical");
        onStateChange?.("critical");
        inference.setLowComputeMode(true);
      } else if (tier === "low_compute") {
        db.setAgentState("low_compute");
        onStateChange?.("low_compute");
        inference.setLowComputeMode(true);
      } else {
        if (db.getAgentState() !== "running") {
          db.setAgentState("running");
          onStateChange?.("running");
        }
        inference.setLowComputeMode(false);
      }

      // Build context
      const recentTurns = trimContext(db.getRecentTurns(20));
      const systemPrompt = buildSystemPrompt({
        identity,
        config,
        financial,
        state: db.getAgentState(),
        db,
        tools,
        skills,
        isFirstRun,
      });

      const messages = buildContextMessages(
        systemPrompt,
        recentTurns,
        pendingInput,
      );

      // Capture input before clearing
      const currentInput = pendingInput;

      // Clear pending input after use
      pendingInput = undefined;

      // ── Inference Call ──
      log(config, `[THINK] Calling ${inference.getDefaultModel()}...`);

      const response = await inference.chat(messages, {
        tools: toolsToInferenceFormat(tools),
      });

      const turn: AgentTurn = {
        id: ulid(),
        timestamp: new Date().toISOString(),
        state: db.getAgentState(),
        input: currentInput?.content,
        inputSource: currentInput?.source as any,
        thinking: response.message.content || "",
        toolCalls: [],
        tokenUsage: response.usage,
        costCents: estimateCostCents(response.usage, inference.getDefaultModel()),
      };

      // ── Execute Tool Calls ──
      if (response.toolCalls && response.toolCalls.length > 0) {
        const toolCallMessages: any[] = [];
        let callCount = 0;

        for (const tc of response.toolCalls) {
          if (callCount >= MAX_TOOL_CALLS_PER_TURN) {
            log(config, `[TOOLS] Max tool calls per turn reached (${MAX_TOOL_CALLS_PER_TURN})`);
            break;
          }

          let args: Record<string, unknown>;
          try {
            args = JSON.parse(tc.function.arguments);
          } catch {
            args = {};
          }

          log(config, `[TOOL] ${tc.function.name}(${JSON.stringify(args).slice(0, 100)})`);

          const result = await executeTool(
            tc.function.name,
            args,
            tools,
            toolContext,
          );

          // Override the ID to match the inference call's ID
          result.id = tc.id;
          turn.toolCalls.push(result);

          log(
            config,
            `[TOOL RESULT] ${tc.function.name}: ${result.error ? `ERROR: ${result.error}` : result.result.slice(0, 200)}`,
          );

          callCount++;
        }
      }

      // ── Persist Turn ──
      db.insertTurn(turn);
      for (const tc of turn.toolCalls) {
        db.insertToolCall(turn.id, tc);
      }
      onTurnComplete?.(turn);

      // Log the turn
      if (turn.thinking) {
        log(config, `[THOUGHT] ${turn.thinking.slice(0, 300)}`);
      }

      // ── Check for sleep command ──
      const sleepTool = turn.toolCalls.find((tc) => tc.name === "sleep");
      if (sleepTool && !sleepTool.error) {
        log(config, "[SLEEP] Agent chose to sleep.");
        db.setAgentState("sleeping");
        onStateChange?.("sleeping");
        running = false;
        break;
      }

      // ── Follow-up loop: if tool calls were made, feed results back to the model ──
      if (turn.toolCalls.length > 0) {
        let followUps = 0;

        while (followUps < MAX_FOLLOW_UPS) {
          followUps++;
          log(config, `[FOLLOW-UP ${followUps}/${MAX_FOLLOW_UPS}] Processing tool results...`);

          // Rebuild context with the latest turns (including tool results)
          const followUpTurns = trimContext(db.getRecentTurns(20));
          const followUpSystem = buildSystemPrompt({
            identity, config, financial,
            state: db.getAgentState(), db, tools, skills, isFirstRun: false,
          });
          const followUpMessages = buildContextMessages(followUpSystem, followUpTurns);

          const followUpResponse = await inference.chat(followUpMessages, {
            tools: toolsToInferenceFormat(tools),
          });

          const followUpTurn: AgentTurn = {
            id: ulid(),
            timestamp: new Date().toISOString(),
            state: db.getAgentState(),
            input: undefined,
            inputSource: undefined,
            thinking: followUpResponse.message.content || "",
            toolCalls: [],
            tokenUsage: followUpResponse.usage,
            costCents: estimateCostCents(followUpResponse.usage, inference.getDefaultModel()),
          };

          // Execute any additional tool calls
          if (followUpResponse.toolCalls && followUpResponse.toolCalls.length > 0) {
            let callCount = 0;
            for (const tc of followUpResponse.toolCalls) {
              if (callCount >= MAX_TOOL_CALLS_PER_TURN) break;

              let fArgs: Record<string, unknown>;
              try { fArgs = JSON.parse(tc.function.arguments); } catch { fArgs = {}; }

              log(config, `[TOOL] ${tc.function.name}(${JSON.stringify(fArgs).slice(0, 100)})`);

              const result = await executeTool(tc.function.name, fArgs, tools, toolContext);
              result.id = tc.id;
              followUpTurn.toolCalls.push(result);

              log(config, `[TOOL RESULT] ${tc.function.name}: ${result.error ? `ERROR: ${result.error}` : result.result.slice(0, 200)}`);
              callCount++;
            }
          }

          // Persist follow-up turn
          db.insertTurn(followUpTurn);
          for (const tc of followUpTurn.toolCalls) {
            db.insertToolCall(followUpTurn.id, tc);
          }
          onTurnComplete?.(followUpTurn);

          if (followUpTurn.thinking) {
            log(config, `[THOUGHT] ${followUpTurn.thinking.slice(0, 300)}`);
          }

          // Check if the follow-up triggered a sleep
          const followUpSleep = followUpTurn.toolCalls.find((tc) => tc.name === "sleep");
          if (followUpSleep && !followUpSleep.error) {
            log(config, "[SLEEP] Agent chose to sleep during follow-up.");
            db.setAgentState("sleeping");
            onStateChange?.("sleeping");
            running = false;
            break;
          }

          // If no tool calls in this follow-up, the agent is done reasoning
          if (followUpTurn.toolCalls.length === 0) {
            log(config, `[FOLLOW-UP] Chain complete after ${followUps} step(s).`);
            break;
          }
        }

        if (!running) break; // Sleep was triggered in follow-up
      }

      // ── If no tool calls and just text, the agent might be done thinking ──
      if (
        (!response.toolCalls || response.toolCalls.length === 0) &&
        response.finishReason === "stop"
      ) {
        // Agent produced text without tool calls.
        // This is a natural pause point -- no work queued, sleep briefly.
        log(config, "[IDLE] No pending inputs. Entering brief sleep.");
        db.setKV(
          "sleep_until",
          new Date(Date.now() + 60_000).toISOString(),
        );
        db.setAgentState("sleeping");
        onStateChange?.("sleeping");
        running = false;
      }

      consecutiveErrors = 0;
    } catch (err: any) {
      consecutiveErrors++;
      const errorMessage = err.message || String(err);
      log(config, `[ERROR] Turn failed: ${errorMessage}`);

      // Handle specific terminal errors (Upstream Quota)
      if (errorMessage.includes("insufficient_quota") || errorMessage.includes("429")) {
        log(config, `[FATAL] Upstream quota exceeded. Entering survival sleep for 30 minutes.`);
        db.setAgentState("sleeping");
        onStateChange?.("sleeping");
        db.setKV(
          "sleep_until",
          new Date(Date.now() + 1800_000).toISOString(),
        );
        running = false;
        break;
      }

      if (consecutiveErrors >= MAX_CONSECUTIVE_ERRORS) {
        log(
          config,
          `[FATAL] ${MAX_CONSECUTIVE_ERRORS} consecutive errors. Sleeping.`,
        );
        db.setAgentState("sleeping");
        onStateChange?.("sleeping");
        db.setKV(
          "sleep_until",
          new Date(Date.now() + 300_000).toISOString(),
        );
        running = false;
      }
    }
  }

  log(config, `[LOOP END] Agent loop finished. State: ${db.getAgentState()}`);
}

// ─── Helpers ───────────────────────────────────────────────────

async function getFinancialState(
  conway: ConwayClient,
  address: string,
  solanaAddress?: string,
): Promise<FinancialState> {
  let creditsCents = 0;
  let usdcBalance = 0;
  let solanaUsdcBalance = 0;

  try {
    creditsCents = await conway.getCreditsBalance();
  } catch { }

  try {
    usdcBalance = await getUsdcBalance(address as `0x${string}`);
  } catch { }

  if (solanaAddress) {
    try {
      // Check both Mainnet and Devnet; take the higher for survival purposes
      const [mainnet, devnet] = await Promise.all([
        getUsdcBalance(solanaAddress, "solana:mainnet").catch(() => 0),
        getUsdcBalance(solanaAddress, "solana:devnet").catch(() => 0),
      ]);
      solanaUsdcBalance = Math.max(mainnet, devnet);
    } catch { }
  }

  return {
    creditsCents,
    usdcBalance,
    solanaUsdcBalance,
    lastChecked: new Date().toISOString(),
  };
}

function estimateCostCents(
  usage: { promptTokens: number; completionTokens: number },
  model: string,
): number {
  // Rough cost estimation per million tokens
  const pricing: Record<string, { input: number; output: number }> = {
    "gpt-4o": { input: 250, output: 1000 },
    "gpt-4o-mini": { input: 15, output: 60 },
    "gpt-4.1": { input: 200, output: 800 },
    "gpt-4.1-mini": { input: 40, output: 160 },
    "gpt-4.1-nano": { input: 10, output: 40 },
    "gpt-5.2": { input: 200, output: 800 },
    "o1": { input: 1500, output: 6000 },
    "o3-mini": { input: 110, output: 440 },
    "o4-mini": { input: 110, output: 440 },
    "claude-sonnet-4-5": { input: 300, output: 1500 },
    "claude-haiku-4-5": { input: 100, output: 500 },
  };

  const p = pricing[model] || pricing["gpt-4o"];
  const inputCost = (usage.promptTokens / 1_000_000) * p.input;
  const outputCost = (usage.completionTokens / 1_000_000) * p.output;
  return Math.ceil((inputCost + outputCost) * 1.3); // 1.3x Conway markup
}


/**
 * Attempt to fund the automaton by buying credits using Solana USDC if Base credits are 0.
 */
export async function checkAndFundCredits(
  config: AutomatonConfig,
  conway: ConwayClient,
  financial: FinancialState,
  identity: AutomatonIdentity,
  db: AutomatonDatabase,
): Promise<boolean> {
  const solanaUsdc = financial.solanaUsdcBalance;
  const baseUsdc = financial.usdcBalance;
  if (solanaUsdc < 0.1 && baseUsdc < 0.1) return false; // Need at least 10 cents total

  log(
    config,
    `[RESCUE] Credits are 0, but treasury has $${(solanaUsdc + baseUsdc).toFixed(2)}. Attempting to restore compute credits...`,
  );

  // Credits are purchased through Conway's billing dashboard.
  // The agent can't directly buy credits via API — it needs manual top-up.
  // But we can still bridge Solana USDC → Base for wallet funding (domains, etc).
  if (financial.creditsCents <= 0) {
    log(config, `[RESCUE] ⚠️ Credits depleted. Purchase credits at Conway dashboard (https://conway.tech/billing).`);
    log(config, `[RESCUE] Wallet balances: Base USDC $${baseUsdc.toFixed(2)}, Solana USDC $${solanaUsdc.toFixed(2)}`);
  }

  // PHASE 2: Autonomous Bridge (if Solana → Base needed for wallet funding)
  // Re-fetch state to ensure we have the latest balances before making a bridge decision
  const solAddress = await (await import("../identity/solana-wallet.js")).getSolanaAddress();
  const latestFinancial = await getFinancialState(conway, identity.address, solAddress || undefined);
  const solanaUsdcFresh = latestFinancial.solanaUsdcBalance;
  const baseUsdcFresh = latestFinancial.usdcBalance;

  const shouldBridge = config.autoBridgeRefill !== false;
  const bridgeThreshold = config.bridgeRefillAmount || 2.0;

  // Bridge Solana USDC → Base if Base wallet is low (for domain purchases, etc)
  // Also crucial for x402 payments if credits are 0.
  if (shouldBridge) {
    if (solanaUsdcFresh >= bridgeThreshold && baseUsdcFresh < 1.0) {
      log(
        config,
        `[RESCUE] Phase 2: Attempting to self-bridge $${bridgeThreshold} USDC from Solana to Base to stay alive...`,
      );
      try {
        const { bridgeUsdcToBase } = await import("./bridge/index.js");
        const bridgeResult = await bridgeUsdcToBase(bridgeThreshold);
        if (bridgeResult.success) {
          log(config, `[RESCUE] Bridge initiated! Tx: ${bridgeResult.txId}.`);
          log(
            config,
            `[RESCUE] Entering Survival Nap for 20 minutes to allow bridging to complete...`,
          );

          db.setAgentState("sleeping");
          return false;
        }
      } catch (err: any) {
        log(config, `[RESCUE] Bridge attempt failed: ${err.message}`);
      }
    } else if (baseUsdcFresh < 1.0 && solanaUsdcFresh < bridgeThreshold) {
      log(config, `[RESCUE] Cannot bridge: Solana balance ($${solanaUsdcFresh}) below threshold ($${bridgeThreshold})`);
    } else if (baseUsdcFresh >= 1.0) {
      // We have funds, but maybe not enough? 1.0 is plenty for many inferences.
    }
  } else {
    log(config, `[RESCUE] Auto-bridging disabled in config.`);
  }

  // PHASE 3: Final Verification
  // Re-fetch state and check tier. If we are back to 'normal' (via Base/Solana USDC), 
  // then we considered the refuel a success even if the central credit endpoints didn't work.
  const solanaAddress = await (await import("../identity/solana-wallet.js")).getSolanaAddress();
  const finalState = await getFinancialState(conway, identity.address, solanaAddress || undefined);
  const { getSurvivalTier } = await import("../conway/credits.js");
  const finalTier = getSurvivalTier(finalState);

  if (finalTier === "normal") {
    log(config, `[RESCUE] Agent is now in NORMAL survival state ($${((finalState.creditsCents + (finalState.usdcBalance * 100) + (finalState.solanaUsdcBalance * 100)) / 100).toFixed(2)} liquidity).`);
    return true;
  }

  return false;
}

function log(config: AutomatonConfig, message: string): void {
  if (config.logLevel === "debug" || config.logLevel === "info") {
    const timestamp = new Date().toISOString();
    console.log(`[${timestamp}] ${message}`);
  }
}
