#!/usr/bin/env node
import "./prelude.js";
/**
 * Conway Automaton Runtime
 *
 * The entry point for the sovereign AI agent.
 * Handles CLI args, bootstrapping, and orchestrating
 * the heartbeat daemon + agent loop.
 */

import { getWallet, getAutomatonDir } from "./identity/wallet.js";
import { getSolanaWallet, getSolanaAddress } from "./identity/solana-wallet.js";
import { provision, loadApiKeyFromConfig } from "./identity/provision.js";
import { Command } from "commander";
import chalk from "chalk";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { createConfig, loadConfig, saveConfig, resolvePath } from "./config.js";
import { createDatabase } from "./state/database.js";
import { createConwayClient } from "./conway/client.js";
import { createInferenceClient } from "./conway/inference.js";
import { createHeartbeatDaemon } from "./heartbeat/daemon.js";
import {
  loadHeartbeatConfig,
  syncHeartbeatToDb,
} from "./heartbeat/config.js";
import { runAgentLoop } from "./agent/loop.js";
import { loadSkills } from "./skills/loader.js";
import { initStateRepo } from "./git/state-versioning.js";
import { createSocialClient } from "./social/client.js";
import type { AutomatonIdentity, AgentState, Skill, SocialClientInterface } from "./types.js";

const VERSION = "0.1.0";

async function main(): Promise<void> {
  const args = process.argv.slice(2);

  // ─── CLI Commands ────────────────────────────────────────────

  if (args.includes("--version") || args.includes("-v")) {
    console.log(`Conway Automaton v${VERSION}`);
    process.exit(0);
  }

  if (args.includes("--help") || args.includes("-h")) {
    console.log(`
Conway Automaton v${VERSION}
Sovereign AI Agent Runtime

Usage:
  automaton --run          Start the automaton (first run triggers setup wizard)
  automaton --setup        Re-run the interactive setup wizard
  automaton --init         Initialize wallet and config directory
  automaton --provision    Provision Conway API key via SIWE
  automaton --status       Show current automaton status
  automaton --check-domain <domain>  Check domain availability
  automaton --buy-domain   <domain>  Purchase a domain
  automaton --bridge-funds <amount>  Bridge USDC from Solana to Base
  automaton --version      Show version
  automaton --help         Show this help

Environment:
  CONWAY_API_URL           Conway API URL (default: https://api.conway.tech)
  CONWAY_API_KEY           Conway API key (overrides config)
`);
    process.exit(0);
  }

  if (args.includes("--init")) {
    const { account, isNew } = await getWallet();
    const { keypair, isNew: isSolanaNew } = await getSolanaWallet();
    console.log(
      JSON.stringify({
        address: account.address,
        solanaAddress: keypair.publicKey.toBase58(),
        isNew,
        isSolanaNew,
        configDir: getAutomatonDir(),
      }),
    );
    process.exit(0);
  }

  if (args.includes("--provision")) {
    try {
      const result = await provision();
      console.log(JSON.stringify(result));
    } catch (err: any) {
      console.error(`Provision failed: ${err.message}`);
      process.exit(1);
    }
    process.exit(0);
  }

  if (args.includes("--status")) {
    await showStatus();
    process.exit(0);
  }

  if (args.includes("--check-domain")) {
    const domain = args[args.indexOf("--check-domain") + 1];
    if (!domain) {
      console.error("Please specify a domain to check.");
      process.exit(1);
    }
    await checkDomain(domain);
    process.exit(0);
  }

  if (args.includes("--buy-domain")) {
    const domain = args[args.indexOf("--buy-domain") + 1];
    if (!domain) {
      console.error("Please specify a domain to buy.");
      process.exit(1);
    }
    await buyDomain(domain);
    process.exit(0);
  }

  if (args.includes("--bridge-funds")) {
    const amountStr = args[args.indexOf("--bridge-funds") + 1];
    const amount = parseFloat(amountStr);
    if (isNaN(amount) || amount <= 0) {
      console.error("Please specify a valid amount of USDC to bridge.");
      process.exit(1);
    }
    await bridgeFunds(amount);
    process.exit(0);
  }

  if (args.includes("--setup")) {
    const { runSetupWizard } = await import("./setup/wizard.js");
    await runSetupWizard();
    process.exit(0);
  }

  if (args.includes("--dashboard") || args.includes("--web")) {
    const { startDashboardServer } = await import("./web/server.js");
    startDashboardServer();
  }

  if (args.includes("--run")) {
    await run();
    return;
  }

  // Default: show help
  console.log('Run "automaton --help" for usage information.');
  console.log('Run "automaton --run" to start the automaton.');
  console.log('Run "automaton --dashboard" to launch the Sovereign Dashboard UI.');
}

// ─── Status Command ────────────────────────────────────────────

async function showStatus(): Promise<void> {
  const config = loadConfig();
  if (!config) {
    console.log("Automaton is not configured. Run the setup script first.");
    return;
  }

  const dbPath = resolvePath(config.dbPath);
  const db = createDatabase(dbPath);

  const state = db.getAgentState();
  const turnCount = db.getTurnCount();
  const tools = db.getInstalledTools();
  const heartbeats = db.getHeartbeatEntries();
  const skills = db.getSkills(true);
  const children = db.getChildren();
  const registry = db.getRegistryEntry();

  let solBalanceInfo = "not loaded";
  try {
    const { getSolanaConnection, getDevnetConnection } = await import("./conway/solana.js");
    const { getUsdcBalance } = await import("./conway/x402.js");
    const agentSolanaAddress = await (await import("./identity/solana-wallet.js")).getSolanaAddress();

    if (agentSolanaAddress) {
      const connMain = getSolanaConnection();
      const connDev = getDevnetConnection();
      const pubkey = new (await import("@solana/web3.js")).PublicKey(agentSolanaAddress);

      const [balMain, balDev, usdcMain, usdcDev] = await Promise.all([
        connMain.getBalance(pubkey).catch(() => 0),
        connDev.getBalance(pubkey).catch(() => 0),
        getUsdcBalance(agentSolanaAddress, "solana:mainnet").catch(() => 0),
        getUsdcBalance(agentSolanaAddress, "solana:devnet").catch(() => 0)
      ]);

      solBalanceInfo = `${agentSolanaAddress}
            Mainnet: ${(balMain / 1_000_000_000).toFixed(4)} SOL | ${usdcMain.toFixed(2)} USDC
            Devnet:  ${(balDev / 1_000_000_000).toFixed(4)} SOL  | ${usdcDev.toFixed(2)} USDC`;
    }
  } catch (e) {
    solBalanceInfo = `error loading: ${e instanceof Error ? e.message : String(e)}`;
  }

  console.log(`
=== AUTOMATON STATUS ===
Name:       ${config.name}
Address:    ${config.walletAddress}
Solana:     ${solBalanceInfo}
Creator:    ${config.creatorAddress}
Sandbox:    ${config.sandboxId}
State:      ${state}
Turns:      ${turnCount}
Tools:      ${tools.length} installed
Skills:     ${skills.length} active
Heartbeats: ${heartbeats.filter((h) => h.enabled).length} active
Children:   ${children.filter((c) => c.status !== "dead").length} alive / ${children.length} total
Agent ID:   ${registry?.agentId || "not registered"}
Model:      ${config.inferenceModel}
Version:    ${config.version}
========================
`);

  db.close();
}

// ─── Domain Commands ───────────────────────────────────────────

async function checkDomain(domain: string): Promise<void> {
  const config = loadConfig();
  if (!config) { console.error("No config found."); return; }
  const apiKey = config.conwayApiKey || loadApiKeyFromConfig();
  if (!apiKey) { console.error("No API key found."); return; }

  const { loadSolanaKeypair } = await import("./identity/solana-wallet.js");
  const solanaKeypair = await loadSolanaKeypair();
  const { account } = await getWallet();

  const conway = createConwayClient({
    apiUrl: config.conwayApiUrl,
    apiKey,
    sandboxId: config.sandboxId,
    identity: { evm: account, solana: solanaKeypair || undefined },
  });

  console.log(`Checking availability for: ${domain}...`);
  try {
    const results = await conway.searchDomains(domain);
    const match = results.find(r => r.domain === domain);
    if (!match) {
      console.log(`Domain ${domain} not found in search results.`);
    } else {
      console.log(`
Domain: ${match.domain}
Available: ${match.available}
Price: $${((match.registrationPrice || 0) / 100).toFixed(2)} ${match.currency}
Renewal: $${((match.renewalPrice || 0) / 100).toFixed(2)} ${match.currency}
`);
    }
  } catch (err: any) {
    console.error(`Check failed: ${err.message}`);
  }
}

async function buyDomain(domain: string): Promise<void> {
  const config = loadConfig();
  if (!config) { console.error("No config found."); return; }
  const apiKey = config.conwayApiKey || loadApiKeyFromConfig();
  if (!apiKey) { console.error("No API key found."); return; }

  const { loadSolanaKeypair } = await import("./identity/solana-wallet.js");
  const solanaKeypair = await loadSolanaKeypair();
  const { account } = await getWallet();

  const conway = createConwayClient({
    apiUrl: config.conwayApiUrl,
    apiKey,
    sandboxId: config.sandboxId,
    identity: { evm: account, solana: solanaKeypair || undefined },
  });

  console.log(`Attempting to purchase: ${domain}...`);
  console.log(`(Note: This will attempt to pay using Solana USDC if available)`);

  try {
    const result = await conway.registerDomain(domain, 1);
    console.log(chalk.green(`\nSuccessfully registered ${result.domain}!`));
    console.log(`Expires: ${result.expiresAt}`);
    console.log(`Tx ID: ${result.transactionId}`);
  } catch (err: any) {
    console.error(chalk.red(`\nPurchase failed: ${err.message}`));
    if (err.message.includes("404")) {
      console.log(chalk.yellow("Hint: The domains API might not be deployed yet."));
    }
  }
}

async function bridgeFunds(amount: number): Promise<void> {
  const { bridgeUsdcToBase } = await import("./agent/bridge/index.js");

  console.log(`Initiating bridge of ${amount} USDC from Solana to Base...`);
  const result = await bridgeUsdcToBase(amount);

  if (result.success) {
    console.log(chalk.green(`\nBridge Submitted Successfully!`));
    console.log(`Tx ID: ${result.txId}`);
    console.log(`Expected Output: ${result.expectedAmountOut} USDC`);
    console.log(`ETA: ~${result.eta} seconds`);
  } else {
    console.error(chalk.red(`\nBridge Failed: ${result.error}`));
  }
}

// ─── Main Run ──────────────────────────────────────────────────

async function run(): Promise<void> {
  console.log(`[${new Date().toISOString()}] Conway Automaton v${VERSION} starting...`);

  // Load config — first run triggers interactive setup wizard
  let config = loadConfig();
  if (!config) {
    const { runSetupWizard } = await import("./setup/wizard.js");
    config = await runSetupWizard();
  }

  // Load wallet
  const { account } = await getWallet();
  const apiKey = config.conwayApiKey || loadApiKeyFromConfig();
  if (!apiKey) {
    console.error(
      "No API key found. Run: automaton --provision",
    );
    process.exit(1);
  }

  // Build identity
  const identity: AutomatonIdentity = {
    name: config.name,
    address: account.address,
    account,
    creatorAddress: config.creatorAddress,
    sandboxId: config.sandboxId,
    apiKey,
    createdAt: new Date().toISOString(),
  };

  // Initialize database
  const dbPath = resolvePath(config.dbPath);
  const db = createDatabase(dbPath);

  // Store identity in DB
  db.setIdentity("name", config.name);
  db.setIdentity("address", account.address);
  db.setIdentity("creator", config.creatorAddress);
  db.setIdentity("sandbox", config.sandboxId);

  // Create Conway client
  const { loadSolanaKeypair } = await import("./identity/solana-wallet.js");
  const solanaKeypair = await loadSolanaKeypair();

  const conway = createConwayClient({
    apiUrl: config.conwayApiUrl,
    apiKey,
    sandboxId: config.sandboxId,
    identity: {
      evm: account,
      solana: solanaKeypair || undefined,
    },
  });

  // Create inference client
  // Use dedicated inference endpoint for x402 support (bypassing control plane credit check)
  const inferenceApiUrl = "https://inference.conway.tech";

  const inference = createInferenceClient({
    apiUrl: inferenceApiUrl,
    apiKey,
    defaultModel: "gpt-5-mini",
    lowComputeModel: "gpt-5-mini",
    maxTokens: config.maxTokensPerTurn,
    identity: {
      evm: account,
      solana: solanaKeypair || undefined,
    },
  });

  // Create social client
  let social: SocialClientInterface | undefined;
  if (config.socialRelayUrl) {
    social = createSocialClient(config.socialRelayUrl, account);
    console.log(`[${new Date().toISOString()}] Social relay: ${config.socialRelayUrl}`);
  }

  // Load and sync heartbeat config
  const heartbeatConfigPath = resolvePath(config.heartbeatConfigPath);
  const heartbeatConfig = loadHeartbeatConfig(heartbeatConfigPath);
  syncHeartbeatToDb(heartbeatConfig, db);

  // Load skills
  const skillsDir = config.skillsDir || "~/.automaton/skills";
  let skills: Skill[] = [];
  try {
    skills = loadSkills(skillsDir, db);
    console.log(`[${new Date().toISOString()}] Loaded ${skills.length} skills.`);
  } catch (err: any) {
    console.warn(`[${new Date().toISOString()}] Skills loading failed: ${err.message}`);
  }

  // Initialize state repo (git)
  try {
    await initStateRepo(conway);
    console.log(`[${new Date().toISOString()}] State repo initialized.`);
  } catch (err: any) {
    console.warn(`[${new Date().toISOString()}] State repo init failed: ${err.message}`);
  }

  // Start heartbeat daemon
  const heartbeat = createHeartbeatDaemon({
    identity,
    config,
    db,
    conway,
    social,
    onWakeRequest: (reason) => {
      console.log(`[HEARTBEAT] Wake request: ${reason}`);
      // The heartbeat can trigger the agent loop
      // In the main run loop, we check for wake requests
      db.setKV("wake_request", reason);
    },
  });

  heartbeat.start();
  console.log(`[${new Date().toISOString()}] Heartbeat daemon started.`);

  // Handle graceful shutdown
  const shutdown = () => {
    console.log(`[${new Date().toISOString()}] Shutting down...`);
    heartbeat.stop();
    db.setAgentState("sleeping");
    db.close();
    process.exit(0);
  };

  process.on("SIGTERM", shutdown);
  process.on("SIGINT", shutdown);

  // ─── Main Run Loop ──────────────────────────────────────────
  // The automaton alternates between running and sleeping.
  // The heartbeat can wake it up.

  while (true) {
    try {
      // Reload skills (may have changed since last loop)
      try {
        skills = loadSkills(skillsDir, db);
      } catch { }

      // Run the agent loop
      await runAgentLoop({
        identity,
        config,
        db,
        conway,
        inference,
        social,
        skills,
        onStateChange: (state: AgentState) => {
          console.log(`[${new Date().toISOString()}] State: ${state}`);
        },
        onTurnComplete: (turn) => {
          console.log(
            `[${new Date().toISOString()}] Turn ${turn.id}: ${turn.toolCalls.length} tools, ${turn.tokenUsage.totalTokens} tokens`,
          );
        },
      });

      // Agent loop exited (sleeping or dead)
      const state = db.getAgentState();

      if (state === "dead") {
        console.log(`[${new Date().toISOString()}] Automaton is dead. Heartbeat will continue.`);
        // In dead state, we just wait for funding
        // The heartbeat will keep checking and broadcasting distress
        await sleep(300_000); // Check every 5 minutes
        continue;
      }

      if (state === "sleeping") {
        const sleepUntilStr = db.getKV("sleep_until");
        const sleepUntil = sleepUntilStr
          ? new Date(sleepUntilStr).getTime()
          : Date.now() + 60_000;
        const sleepMs = Math.max(sleepUntil - Date.now(), 10_000);
        console.log(
          `[${new Date().toISOString()}] Sleeping for ${Math.round(sleepMs / 1000)}s`,
        );

        // Sleep, but check for wake requests periodically
        const checkInterval = Math.min(sleepMs, 30_000);
        let slept = 0;
        while (slept < sleepMs) {
          await sleep(checkInterval);
          slept += checkInterval;

          // Check for wake request from heartbeat
          const wakeRequest = db.getKV("wake_request");
          if (wakeRequest) {
            console.log(
              `[${new Date().toISOString()}] Woken by heartbeat: ${wakeRequest}`,
            );
            db.deleteKV("wake_request");
            db.deleteKV("sleep_until");
            break;
          }
        }

        // Clear sleep state
        db.deleteKV("sleep_until");
        continue;
      }
    } catch (err: any) {
      console.error(
        `[${new Date().toISOString()}] Fatal error in run loop: ${err.message}`,
      );
      // Wait before retrying
      await sleep(30_000);
    }
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ─── Entry Point ───────────────────────────────────────────────

main().catch((err) => {
  console.error(`Fatal: ${err.message}`);
  process.exit(1);
});
