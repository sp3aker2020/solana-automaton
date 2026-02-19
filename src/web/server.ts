
import express from "express";
import cors from "cors";
import path from "path";
import fs from "fs";
import { fileURLToPath } from "url";
import { loadConfig, saveConfig, createConfig } from "../config.js";
import { getSolanaAddress, getSolanaBalance, getSolanaWallet } from "../identity/solana-wallet.js";
import { getWallet } from "../identity/wallet.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

let lastStatus: any = null;
let lastFetchTime = 0;
const STATUS_CACHE_DURATION = 30000; // 30 seconds

let lastPrices: any = null;
let lastPricesFetchTime = 0;
const PRICES_CACHE_DURATION = 3600000; // 1 hour

export function startDashboardServer(port: number = 18888) {
    const app = express();
    app.use(cors());
    app.use(express.json());

    // Persistent database connection for the dashboard UI
    let db: any = null;

    // Serve static UI files
    let publicPath = path.join(__dirname, "public");
    if (!fs.existsSync(publicPath)) {
        // Fallback if running from dist/ and public is not copied
        publicPath = path.join(process.cwd(), "src", "web", "public");
    }

    if (fs.existsSync(publicPath)) {
        app.use(express.static(publicPath));
    } else {
        console.warn(`[DASHBOARD] Warning: Static assets directory not found at ${publicPath}`);
    }

    /**
     * Status Endpoint
     * Returns live data for the dashboard
     */
    app.get("/api/status", async (req, res) => {
        try {
            const config = loadConfig();

            // If no config, return setup_required state
            if (!config) {
                return res.json({
                    success: true,
                    data: {
                        state: "setup_required",
                        name: "Sovereign Automaton",
                        version: "0.1.0"
                    }
                });
            }

            // Initialize DB connection once if not already done
            if (!db && config.dbPath) {
                const { resolvePath } = await import("../config.js");
                const { createDatabase } = await import("../state/database.js");
                db = createDatabase(resolvePath(config.dbPath));
            }

            const now = Date.now();
            if (lastStatus && (now - lastFetchTime < STATUS_CACHE_DURATION)) {
                return res.json(lastStatus);
            }

            const solanaAddress = await getSolanaAddress();
            const ethWallet = await getWallet();

            let solanaBalance = 0;
            let solanaSol = 0;
            if (solanaAddress) {
                const { getSolanaNativeBalance } = await import("../identity/solana-wallet.js");
                solanaBalance = await getSolanaBalance(solanaAddress);
                solanaSol = await getSolanaNativeBalance(solanaAddress);
            }

            let baseEth = 0;
            let baseUsdc = 0;
            try {
                const { createPublicClient, http, formatEther } = await import("viem");
                const { base } = await import("viem/chains");
                const { getUsdcBalance } = await import("../conway/x402.js");

                const client = createPublicClient({
                    chain: base,
                    transport: http(),
                });

                const [balEth, balUsdc] = await Promise.all([
                    client.getBalance({ address: ethWallet.account.address }),
                    getUsdcBalance(ethWallet.account.address, "eip155:8453")
                ]);

                baseEth = parseFloat(formatEther(balEth));
                baseUsdc = balUsdc;
            } catch (e) {
                // Ignore if Base fetch fails
            }

            let conwayCredits = 0;
            let agentState = "offline";

            if (config.conwayApiKey) {
                try {
                    const { createConwayClient } = await import("../conway/client.js");
                    const client = createConwayClient({
                        apiUrl: config.conwayApiUrl,
                        apiKey: config.conwayApiKey,
                        sandboxId: config.sandboxId || "",
                        identity: {
                            evm: ethWallet.account,
                        }
                    });
                    const balanceCents = await client.getCreditsBalance();
                    conwayCredits = balanceCents / 100;
                    console.log(`[DASHBOARD] Credits Sync: ${conwayCredits} USD for ${ethWallet.account.address}`);
                } catch (e: any) {
                    console.error(`[DASHBOARD] Credits Fetch Error:`, e.message);
                }
            }

            try {
                if (db) {
                    agentState = db.getAgentState() || "idle";
                }
            } catch (e) {
                // DB might not be initialized
            }

            const status = {
                success: true,
                data: {
                    name: config.name || "Unnamed Agent",
                    state: agentState,
                    config: {
                        genesisPrompt: config.genesisPrompt,
                        autoBridgeRefill: config.autoBridgeRefill,
                        bridgeProvider: config.bridgeProvider,
                        bridgeRefillAmount: config.bridgeRefillAmount,
                    },
                    wallets: {
                        solana: solanaAddress,
                        ethereum: ethWallet.account.address,
                    },
                    balances: {
                        solanaUsdc: solanaBalance,
                        solanaSol: solanaSol,
                        baseUsdc: baseUsdc,
                        baseEth: baseEth,
                        conwayCredits: conwayCredits,
                    },
                    logs: db ? db.getSystemLogs() : [],
                    version: config.version || "0.1.0"
                }
            };

            lastStatus = status;
            lastFetchTime = now;
            res.json(status);

        } catch (err: any) {
            res.status(500).json({ success: false, error: err.message });
        }
    });

    /**
     * Setup Endpoint
     * Handles initial agent configuration
     */
    app.post("/api/setup", async (req, res) => {
        try {
            const {
                name,
                genesisPrompt,
                creatorAddress,
                creatorSolanaAddress,
                autoBridgeRefill,
                bridgeProvider
            } = req.body;

            if (!name || !genesisPrompt || !creatorAddress) {
                return res.status(400).json({ success: false, error: "Missing required fields" });
            }

            // 1. Initialize Wallets
            const ethWallet = await getWallet();
            const solWallet = await getSolanaWallet();

            // 2. Create Config
            const config = createConfig({
                name,
                genesisPrompt,
                creatorAddress,
                creatorSolanaAddress,
                walletAddress: ethWallet.account.address,
                registeredWithConway: false,
                sandboxId: "",
                apiKey: "", // Initially empty, will be set during provision
                autoBridgeRefill: !!autoBridgeRefill,
                bridgeProvider: bridgeProvider || "mayan",
                bridgeRefillAmount: (bridgeProvider === "debridge") ? 2.0 : 15.0
            });

            // 3. Save Config
            saveConfig(config);

            // Clear cache to force refresh
            lastStatus = null;
            lastFetchTime = 0;

            res.json({
                success: true,
                message: "Configuration saved successfully",
                wallets: {
                    ethereum: ethWallet.account.address,
                    solana: solWallet.keypair.publicKey.toBase58()
                }
            });
        } catch (err: any) {
            res.status(500).json({ success: false, error: err.message });
        }
    });

    /**
     * Wake Endpoint
     * Forces the agent out of sleep mode
     */
    app.post("/api/wake", async (req, res) => {
        try {
            const config = loadConfig();
            if (!config) return res.status(400).json({ success: false, error: "Not configured" });

            const dbPath = config.dbPath.replace("~", process.env.HOME || "");
            const { createDatabase } = await import("../state/database.js");
            const db = createDatabase(dbPath);

            db.setAgentState("waking");
            db.deleteKV("sleep_until");
            db.deleteKV("sleep_reason");
            db.setKV("wake_request", "Manual wake from dashboard");
            db.close();

            console.log(`[DASHBOARD] Manual WAKE UP triggered by user.`);
            lastStatus = null; // Force refresh

            res.json({ success: true, message: "Agent woken up!" });
        } catch (err: any) {
            res.status(500).json({ success: false, error: err.message });
        }
    });

    /**
     * Inbox Endpoint
     * Allows injecting local messages for the agent to process
     */
    app.post("/api/inbox", async (req, res) => {
        try {
            const { content } = req.body;
            if (!content) return res.status(400).json({ success: false, error: "Missing content" });

            const config = loadConfig();
            if (!config) return res.status(400).json({ success: false, error: "Not configured" });

            const dbPath = config.dbPath.replace("~", process.env.HOME || "");
            const { createDatabase } = await import("../state/database.js");
            const db = createDatabase(dbPath);

            db.insertInboxMessage({
                id: `local_${Date.now()}`,
                from: config.creatorAddress,
                to: config.walletAddress,
                content: content,
                signedAt: new Date().toISOString(),
                createdAt: new Date().toISOString()
            });
            db.close();

            console.log(`[DASHBOARD] Local message injected: ${content.slice(0, 50)}...`);
            res.json({ success: true, message: "Message sent to agent!" });
        } catch (err: any) {
            res.status(500).json({ success: false, error: err.message });
        }
    });

    /**
     * Prices Endpoint
     * Returns current pricing for models and domains
     */
    app.get("/api/prices", async (req, res) => {
        try {
            const config = loadConfig();
            if (!config) return res.status(400).json({ success: false, error: "Not configured" });

            const { createConwayClient } = await import("../conway/client.js");
            const { loadApiKeyFromConfig } = await import("../identity/provision.js");
            const { account } = await getWallet();

            const apiKey = config.conwayApiKey || loadApiKeyFromConfig();
            if (!apiKey) return res.status(403).json({ success: false, error: "No API key" });

            const conway = createConwayClient({
                apiUrl: config.conwayApiUrl,
                apiKey,
                sandboxId: config.sandboxId || "",
                identity: { evm: account }
            });

            const now = Date.now();
            if (lastPrices && (now - lastPricesFetchTime < PRICES_CACHE_DURATION)) {
                return res.json(lastPrices);
            }

            const [models, computePricing] = await Promise.all([
                conway.listModels().catch(() => []),
                conway.getCreditsPricing().catch(() => [])
            ]);

            const prices = {
                success: true,
                data: {
                    models,
                    computePricing,
                    domainTiers: [
                        { tld: ".com", registrationPrice: 1500, renewalPrice: 1500 },
                        { tld: ".ai", registrationPrice: 12000, renewalPrice: 12000 },
                        { tld: ".tech", registrationPrice: 1000, renewalPrice: 1000 },
                        { tld: ".xyz", registrationPrice: 1500, renewalPrice: 1500 }
                    ]
                }
            };

            lastPrices = prices;
            lastPricesFetchTime = now;
            res.json(prices);
        } catch (err: any) {
            res.status(500).json({ success: false, error: err.message });
        }
    });

    /**
     * Bridge Credits Endpoint
     * Bridges USDC from Solana to Base to fund the automaton.
     */
    app.post("/api/bridge-credits", async (req, res) => {
        try {
            const { amount } = req.body;
            if (!amount || isNaN(amount)) {
                return res.status(400).json({ success: false, error: "Invalid amount" });
            }

            const { bridgeUsdcToBase } = await import("../agent/bridge/index.js");
            console.log(`[DASHBOARD] Manual BRIDGE triggered: $${amount} USDC`);
            const result = await bridgeUsdcToBase(Number(amount));

            if (result.success) {
                res.json({ success: true, message: `Bridge initiated! ETA ${result.eta}s`, txId: result.txId });
            } else {
                res.status(400).json({ success: false, error: result.error });
            }
        } catch (err: any) {
            res.status(500).json({ success: false, error: err.message });
        }
    });

    /**
     * Fund Credits Endpoint
     * Triggers the agent's rescue logic to buy credits using on-chain funds.
     */
    app.post("/api/fund-credits", async (req, res) => {
        // Clear cache immediately
        lastStatus = null;
        lastFetchTime = 0;
        try {
            const config = loadConfig();
            if (!config) return res.status(400).json({ success: false, error: "Not configured" });

            const { account } = await getWallet();
            const { loadSolanaKeypair, getSolanaAddress, getSolanaBalance } = await import("../identity/solana-wallet.js");
            const solanaKeypair = await loadSolanaKeypair();
            const { createConwayClient } = await import("../conway/client.js");
            const { getUsdcBalance } = await import("../conway/x402.js");
            const { loadApiKeyFromConfig } = await import("../identity/provision.js");

            const apiKey = config.conwayApiKey || loadApiKeyFromConfig();
            if (!apiKey) return res.status(403).json({ success: false, error: "No API key" });

            const conway = createConwayClient({
                apiUrl: config.conwayApiUrl,
                apiKey,
                sandboxId: (config as any).sandboxId || "",
                identity: { evm: account, solana: solanaKeypair || undefined }
            });

            const solanaAddress = await getSolanaAddress();
            const [baseUsdc, solanaUsdc] = await Promise.all([
                getUsdcBalance(account.address),
                solanaAddress ? getSolanaBalance(solanaAddress) : Promise.resolve(0)
            ]);

            const financial = {
                creditsCents: 0,
                usdcBalance: baseUsdc,
                solanaUsdcBalance: solanaUsdc,
                lastChecked: new Date().toISOString()
            };

            const identity = { account, address: account.address } as any;

            // Reuse the rescue logic!
            const { checkAndFundCredits } = await import("../agent/loop.js");

            const dbPath = config.dbPath.replace("~", process.env.HOME || "");
            const { createDatabase } = await import("../state/database.js");
            const db = createDatabase(dbPath);

            console.log(`[DASHBOARD] Manual REFUEL triggered. Balance: $${baseUsdc} Base | $${solanaUsdc} Solana`);
            const funded = await checkAndFundCredits(config as any, conway, financial, identity, db);
            db.close();

            if (funded) {
                lastStatus = null; // Force refresh
                res.json({ success: true, message: "Credits purchased successfully!" });
            } else {
                res.status(400).json({ success: false, error: "Funding failed. Do you have at least $0.10 USDC on Base or Solana?" });
            }
        } catch (err: any) {
            console.error("[DASHBOARD] Refuel Error:", err);
            res.status(500).json({ success: false, error: err.message });
        }
    });

    app.listen(port, () => {
        console.log(`\n  ✨ Sovereign Dashboard active at http://localhost:${port}`);
    });
}
