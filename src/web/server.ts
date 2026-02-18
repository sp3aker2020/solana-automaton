
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
const CACHE_DURATION = 60000; // 60 seconds

export function startDashboardServer(port: number = 18888) {
    const app = express();
    app.use(cors());
    app.use(express.json());

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

            const now = Date.now();
            if (lastStatus && (now - lastFetchTime < CACHE_DURATION)) {
                return res.json(lastStatus);
            }

            const dbPath = config.dbPath.replace("~", process.env.HOME || "");
            const { createDatabase } = await import("../state/database.js");
            const db = createDatabase(dbPath);

            const solanaAddress = await getSolanaAddress();
            const ethWallet = await getWallet();

            let solanaBalance = 0;
            if (solanaAddress) {
                solanaBalance = await getSolanaBalance(solanaAddress);
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
                } catch (e) {
                    // Client might fail if offline or bad key
                }
            }

            try {
                agentState = db.getAgentState() || "idle";
            } catch (e) {
                // DB might not be initialized
            }

            db.close();

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
                        conwayCredits: conwayCredits,
                    },
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
                bridgeProvider: bridgeProvider || "mayan"
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

    app.listen(port, () => {
        console.log(`\n  ✨ Sovereign Dashboard active at http://localhost:${port}`);
    });
}
