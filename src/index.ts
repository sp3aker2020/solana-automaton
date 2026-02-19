#!/usr/bin/env node
import "./prelude.js";
import { loadEnvFile } from "node:process";

try {
  loadEnvFile();
} catch {
  // Ignore if .env doesn't exist
}
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
    console.log(`Conway SOLAUTO v${VERSION}`);
    process.exit(0);
  }

  if (args.includes("--help") || args.includes("-h")) {
    console.log(`
Conway SOLAUTO v${VERSION}
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
  automaton --prices       Show current market rates for compute & domains
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
    let amount = parseFloat(amountStr);

    if (isNaN(amount) || amount <= 0) {
      const { promptRequired } = await import("./setup/prompts.js");
      const input = await promptRequired("Amount of USDC to bridge to credits:");
      amount = parseFloat(input);
    }

    if (isNaN(amount) || amount <= 0) {
      console.error("Invalid amount.");
      process.exit(1);
    }

    await bridgeFunds(amount);
    process.exit(0);
  }

  if (args.includes("--prices")) {
    await showPrices();
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

  let solUsdc = 0;
  let baseUsdc = 0;
  let agentSolanaAddress = "";

  let solBalanceInfo = "not loaded";
  try {
    const { getSolanaConnection, getDevnetConnection } = await import("./conway/solana.js");
    const { getUsdcBalance } = await import("./conway/x402.js");
    agentSolanaAddress = await (await import("./identity/solana-wallet.js")).getSolanaAddress() || "";

    if (agentSolanaAddress) {
      const connMain = getSolanaConnection();
      const connDev = getDevnetConnection();
      const pubkey = new (await import("@solana/web3.js")).PublicKey(agentSolanaAddress);

      const [balMain, balDev, uMain, uDev] = await Promise.all([
        connMain.getBalance(pubkey).catch(() => 0),
        connDev.getBalance(pubkey).catch(() => 0),
        getUsdcBalance(agentSolanaAddress, "solana:mainnet").catch(() => 0),
        getUsdcBalance(agentSolanaAddress, "solana:devnet").catch(() => 0)
      ]);

      solUsdc = uMain;
      solBalanceInfo = `${agentSolanaAddress}
            Mainnet: ${(balMain / 1_000_000_000).toFixed(4)} SOL | ${uMain.toFixed(2)} USDC
            Devnet:  ${(balDev / 1_000_000_000).toFixed(4)} SOL  | ${uDev.toFixed(2)} USDC`;
    }
  } catch (e) {
    solBalanceInfo = `error loading: ${e instanceof Error ? e.message : String(e)}`;
  }

  let baseBalanceInfo = "not loaded";
  try {
    const { getUsdcBalance } = await import("./conway/x402.js");
    const { createPublicClient, http, formatEther } = await import("viem");
    const { base } = await import("viem/chains");

    const client = createPublicClient({
      chain: base,
      transport: http(),
    });

    const [balEth, bUsdc] = await Promise.all([
      client.getBalance({ address: config.walletAddress as `0x${string}` }),
      getUsdcBalance(config.walletAddress, "eip155:8453")
    ]);

    baseUsdc = bUsdc;
    baseBalanceInfo = `${config.walletAddress}
            Mainnet: ${parseFloat(formatEther(balEth)).toFixed(4)} ETH | ${bUsdc.toFixed(2)} USDC`;
  } catch (e) {
    baseBalanceInfo = `error loading: ${e instanceof Error ? e.message : String(e)}`;
  }

  // Fetch Conway Credits
  const apiKey = config.conwayApiKey || (await import("./identity/provision.js")).loadApiKeyFromConfig();
  let runtimeCapacity = 0;
  if (apiKey) {
    const { createConwayClient } = await import("./conway/client.js");
    const { getWallet } = await import("./identity/wallet.js");
    const { loadSolanaKeypair } = await import("./identity/solana-wallet.js");
    const { account } = await getWallet();
    const solanaKeypair = await loadSolanaKeypair();

    const conway = createConwayClient({
      apiUrl: config.conwayApiUrl,
      apiKey,
      sandboxId: config.sandboxId,
      identity: { evm: account, solana: solanaKeypair || undefined },
    });

    const creditsCents = await conway.getCreditsBalance().catch(() => 0);
    runtimeCapacity = creditsCents / 100;
  }

  const totalLiquidity = runtimeCapacity + solUsdc + baseUsdc;

  console.log(`
=== SOVEREIGN AUTOMATON STATUS ===
Name:             ${config.name}
State:            ${state.toUpperCase()}
Runtime Capacity: $${runtimeCapacity.toFixed(2)}
Total Treasury:   $${totalLiquidity.toFixed(2)} (Aggregate USDC)

[WALLETS]
Base Address:     ${config.walletAddress}
Base Balance:     ${baseBalanceInfo.split('\n')[1].trim()}
Solana Address:   ${agentSolanaAddress}
Solana Balance:   ${solBalanceInfo.split('\n')[1].trim()}

[INTERNALS]
Turns:            ${turnCount}
Tools:            ${tools.length} installed
Skills:           ${skills.length} active
Heartbeats:       ${heartbeats.filter((h) => h.enabled).length} active
Agent ID:         ${registry?.agentId || "not registered"}
Model:            ${config.inferenceModel}
Version:          ${config.version}
==================================
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

async function showPrices(): Promise<void> {
  const config = loadConfig();
  if (!config) { console.error("No config found."); return; }
  const apiKey = config.conwayApiKey || (await import("./identity/provision.js")).loadApiKeyFromConfig();
  if (!apiKey) { console.error("No API key found."); return; }

  const { createConwayClient } = await import("./conway/client.js");
  const { getWallet } = await import("./identity/wallet.js");
  const { account } = await getWallet();

  const conway = createConwayClient({
    apiUrl: config.conwayApiUrl,
    apiKey,
    sandboxId: config.sandboxId,
    identity: { evm: account },
  });

  console.log(chalk.cyan("\n=== CONWAY MARKET RATES ==="));

  try {
    const [models, computePricing] = await Promise.all([
      conway.listModels().catch(() => []),
      conway.getCreditsPricing().catch(() => [])
    ]);

    console.log(chalk.yellow("\n[COMPUTE MODELS]"));
    if (models.length === 0) console.log("  No models listed.");
    models.forEach(m => {
      const avg = (m.pricing.inputPerMillion + m.pricing.outputPerMillion) / 2;
      console.log(`  ${chalk.bold(m.id.padEnd(20))} | Avg: $${avg.toFixed(2)} / 1M tokens`);
    });

    console.log(chalk.yellow("\n[COMPUTE TIERS (Monthly)]"));
    if (computePricing.length === 0) console.log("  No tiers listed.");
    computePricing.forEach(t => {
      console.log(`  ${chalk.bold(t.name.padEnd(10))} | ${t.vcpu} vCPU | ${t.memoryMb}MB RAM | $${(t.monthlyCents / 100).toFixed(2)}`);
    });

    console.log(chalk.yellow("\n[DOMAIN REGISTRATION (1 Year)]"));
    const domains = [
      { tld: ".com", price: 15.00 },
      { tld: ".ai", price: 120.00 },
      { tld: ".tech", price: 10.00 },
      { tld: ".xyz", price: 15.00 }
    ];
    domains.forEach(d => {
      console.log(`  ${chalk.bold(d.tld.padEnd(10))} | $${d.price.toFixed(2)}`);
    });

    console.log(chalk.cyan("\n===========================\n"));
  } catch (err: any) {
    console.error(chalk.red(`Failed to fetch prices: ${err.message}`));
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

  // Create inference client — uses x402 for automatic USDC payments via @x402/fetch
  const inference = createInferenceClient({
    apiUrl: "https://inference.conway.tech",
    apiKey,
    defaultModel: "gpt-4o",
    lowComputeModel: "gpt-4o",
    maxTokens: config.maxTokensPerTurn,
    evmAccount: account,
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

  const args = process.argv.slice(2);
  // Handle --wake flag to force clear sleep state
  if (args.includes("--wake")) {
    console.log(`[${new Date().toISOString()}] Force waking agent: clearing sleep state.`);
    db.deleteKV("sleep_until");
    db.setAgentState("waking");
  } else {
    // Normal startup: check if valid sleep state exists
    const currentState = db.getAgentState();
    if (currentState === "sleeping") {
      const sleepUntil = db.getKV("sleep_until");
      if (sleepUntil && new Date(sleepUntil).getTime() > Date.now()) {
        const timeLeft = Math.round((new Date(sleepUntil).getTime() - Date.now()) / 1000);
        console.log(`[${new Date().toISOString()}] Agent is sleeping for ${timeLeft}s more. Use --wake to force start.`);
      }
    }
  }

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

      // Check if we should be sleeping based on persisted state
      const currentState = db.getAgentState();
      const sleepUntilKv = db.getKV("sleep_until");

      if (currentState === "sleeping" && sleepUntilKv && new Date(sleepUntilKv).getTime() > Date.now()) {
        console.log(`[${new Date().toISOString()}] Resuming sleep until ${sleepUntilKv}`);
        // Skip directly to sleep handling block mechanism below
      } else {
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
      }

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
