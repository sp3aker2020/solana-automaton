import fs from "fs";
import path from "path";
import chalk from "chalk";
import type { AutomatonConfig } from "../types.js";
import type { Address } from "viem";
import { getWallet, getAutomatonDir } from "../identity/wallet.js";
import { getSolanaWallet } from "../identity/solana-wallet.js";
import { provision } from "../identity/provision.js";
import { createConfig, saveConfig } from "../config.js";
import { writeDefaultHeartbeatConfig } from "../heartbeat/config.js";
import { showBanner } from "./banner.js";
import { promptRequired, promptMultiline, promptAddress, promptSolanaAddress, promptConfirm, closePrompts } from "./prompts.js";
import { detectEnvironment } from "./environment.js";
import { generateSoulMd, installDefaultSkills } from "./defaults.js";

export async function runSetupWizard(): Promise<AutomatonConfig> {
  showBanner();

  console.log(chalk.white("  First-run setup. Let's bring your automaton to life.\n"));

  // ─── 1. Generate wallet ───────────────────────────────────────
  console.log(chalk.cyan("  [1/6] Generating identity (wallets)..."));
  const { account, isNew } = await getWallet();
  const { keypair, isNew: isSolanaNew } = await getSolanaWallet();

  if (isNew || isSolanaNew) {
    console.log(chalk.green(`  Ethereum Wallet: ${account.address}`));
    console.log(chalk.green(`  Solana Wallet:   ${keypair.publicKey.toBase58()}`));
  } else {
    console.log(chalk.green(`  Identities loaded for ${account.address}`));
  }
  console.log(chalk.dim(`  Keys stored in: ${getAutomatonDir()}\n`));

  // ─── 2. Provision API key ─────────────────────────────────────
  console.log(chalk.cyan("  [2/6] Provisioning Conway API key (SIWE)..."));
  let apiKey = "";
  try {
    const result = await provision();
    apiKey = result.apiKey;
    console.log(chalk.green(`  API key provisioned: ${result.keyPrefix}...\n`));
  } catch (err: any) {
    console.log(chalk.yellow(`  Auto-provision failed: ${err.message}`));
    console.log(chalk.yellow("  You can enter a key manually, or press Enter to skip.\n"));
    const manual = await promptRequired("Conway API key (cnwy_k_...)");
    if (manual) {
      apiKey = manual;
      // Save to config.json for loadApiKeyFromConfig()
      const configDir = getAutomatonDir();
      if (!fs.existsSync(configDir)) {
        fs.mkdirSync(configDir, { recursive: true, mode: 0o700 });
      }
      fs.writeFileSync(
        path.join(configDir, "config.json"),
        JSON.stringify({ apiKey, walletAddress: account.address, provisionedAt: new Date().toISOString() }, null, 2),
        { mode: 0o600 },
      );
      console.log(chalk.green("  API key saved.\n"));
    }
  }

  if (!apiKey) {
    console.log(chalk.yellow("  No API key set. The automaton will have limited functionality.\n"));
  }

  // ─── 3. Interactive questions ─────────────────────────────────
  console.log(chalk.cyan("  [3/6] Setup questions\n"));

  const name = await promptRequired("What do you want to name your automaton?");
  console.log(chalk.green(`  Name: ${name}\n`));

  const genesisPrompt = await promptMultiline("Enter the genesis prompt (system prompt) for your automaton.");
  console.log(chalk.green(`  Genesis prompt set (${genesisPrompt.length} chars)\n`));

  const creatorAddress = await promptAddress("Your Personal Ethereum address (0x...)");
  const creatorSolanaAddress = await promptSolanaAddress("Your Personal Solana address (Base58)");
  console.log(chalk.green(`  Creator: ETH(${creatorAddress.slice(0, 6)}...) SOL(${creatorSolanaAddress.slice(0, 6)}...)\n`));

  console.log(chalk.white("  Autonomous Survival:"));
  const autoBridgeRefill = await promptConfirm("Enable Phase 2 Bridge Refill? (If credits hit 0, agent will bridge 15 USDC from Solana to Base to stay alive. NOTE: Bridge minimum is ~12 USDC)");
  console.log(chalk.green(`  Auto-Bridge Refill: ${autoBridgeRefill ? "Enabled" : "Disabled"}\n`));

  // ─── 4. Detect environment ────────────────────────────────────
  console.log(chalk.cyan("  [4/6] Detecting environment..."));
  const env = detectEnvironment();
  if (env.sandboxId) {
    console.log(chalk.green(`  Conway sandbox detected: ${env.sandboxId}\n`));
  } else {
    console.log(chalk.dim(`  Environment: ${env.type} (no sandbox detected)\n`));
  }

  // ─── 5. Write config + heartbeat + SOUL.md + skills ───────────
  console.log(chalk.cyan("  [5/6] Writing configuration..."));

  const config = createConfig({
    name,
    genesisPrompt,
    creatorAddress: creatorAddress as Address,
    creatorSolanaAddress,
    registeredWithConway: !!apiKey,
    sandboxId: env.sandboxId,
    walletAddress: account.address,
    apiKey,
    autoBridgeRefill,
  });

  saveConfig(config);
  console.log(chalk.green("  automaton.json written"));

  writeDefaultHeartbeatConfig();
  console.log(chalk.green("  heartbeat.yml written"));

  // constitution.md (immutable — copied from repo, protected from self-modification)
  const automatonDir = getAutomatonDir();
  const constitutionSrc = path.join(process.cwd(), "constitution.md");
  const constitutionDst = path.join(automatonDir, "constitution.md");
  if (fs.existsSync(constitutionSrc)) {
    // If destination exists, it might be read-only. Force delete it first.
    if (fs.existsSync(constitutionDst)) {
      try {
        fs.chmodSync(constitutionDst, 0o666); // Make writable
        fs.unlinkSync(constitutionDst);       // Delete
      } catch (e) {
        // Ignore errors if we can't delete, copy might still work or fail specifically
      }
    }
    fs.copyFileSync(constitutionSrc, constitutionDst);
    fs.chmodSync(constitutionDst, 0o444); // read-only
    console.log(chalk.green("  constitution.md installed (read-only)"));
  }

  // SOUL.md
  const soulPath = path.join(automatonDir, "SOUL.md");
  fs.writeFileSync(soulPath, generateSoulMd(name, account.address, creatorAddress, genesisPrompt), { mode: 0o600 });
  console.log(chalk.green("  SOUL.md written"));

  // Default skills
  const skillsDir = config.skillsDir || "~/.automaton/skills";
  installDefaultSkills(skillsDir);
  console.log(chalk.green("  Default skills installed (conway-compute, conway-payments, survival)\n"));

  // ─── 6. Funding guidance ──────────────────────────────────────
  console.log(chalk.cyan("  [6/6] Funding\n"));
  showFundingPanel(account.address, keypair.publicKey.toBase58());

  closePrompts();

  return config;
}

function showFundingPanel(ethAddress: string, solAddress: string): void {
  const shortEth = `${ethAddress.slice(0, 8)}...${ethAddress.slice(-6)}`;
  const shortSol = `${solAddress.slice(0, 8)}...${solAddress.slice(-6)}`;
  const w = 64;
  const pad = (s: string, len: number) => s + " ".repeat(Math.max(0, len - s.length));

  console.log(chalk.cyan(`  ${"╭" + "─".repeat(w) + "╮"}`));
  console.log(chalk.cyan(`  │${pad("  Fund your automaton", w)}│`));
  console.log(chalk.cyan(`  │${" ".repeat(w)}│`));
  console.log(chalk.cyan(`  │${pad(`  Ethereum (Base): ${shortEth}`, w)}│`));
  console.log(chalk.cyan(`  │${pad(`  Solana:          ${shortSol}`, w)}│`));
  console.log(chalk.cyan(`  │${" ".repeat(w)}│`));
  console.log(chalk.cyan(`  │${pad("  1. Transfer Conway credits to Ethereum address", w)}│`));
  console.log(chalk.cyan(`  │${pad("  2. Send USDC on Base directly to Ethereum address", w)}│`));
  console.log(chalk.cyan(`  │${pad("  3. Send SOL or USDC on Solana to Solana address", w)}│`));
  console.log(chalk.cyan(`  │${" ".repeat(w)}│`));
  console.log(chalk.cyan(`  │${pad("  App Dashboard: https://app.conway.tech", w)}│`));
  console.log(chalk.cyan(`  │${" ".repeat(w)}│`));
  console.log(chalk.cyan(`  │${pad("  The automaton starts now. Fund it anytime.", w)}│`));
  console.log(chalk.cyan(`  ${"╰" + "─".repeat(w) + "╯"}`));
  console.log("");
}
