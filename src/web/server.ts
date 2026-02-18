
import express from "express";
import cors from "cors";
import path from "path";
import fs from "fs";
import { fileURLToPath } from "url";
import { loadConfig } from "../config.js";
import { getSolanaAddress, getSolanaBalance } from "../identity/solana-wallet.js";
import { getWallet } from "../identity/wallet.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

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
            if (!config) throw new Error("Config not loaded");

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

            res.json({
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
            });
        } catch (err: any) {
            res.status(500).json({ success: false, error: err.message });
        }
    });

    app.listen(port, () => {
        console.log(`\n  ✨ Sovereign Dashboard active at http://localhost:${port}`);
    });
}
