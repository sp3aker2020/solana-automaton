
import { createConwayClient } from "./dist/conway/client.js";
import { getWallet } from "./dist/identity/wallet.js";
import { loadApiKeyFromConfig } from "./dist/identity/provision.js";
import { loadSolanaKeypair } from "./dist/identity/solana-wallet.js";
import { loadConfig } from "./dist/config.js";

async function diag() {
    const config = loadConfig();
    const apiKey = config.conwayApiKey || loadApiKeyFromConfig();
    const { account } = await getWallet();
    const solanaKeypair = await loadSolanaKeypair();

    const conway = createConwayClient({
        apiUrl: config.conwayApiUrl,
        apiKey,
        sandboxId: config.sandboxId,
        identity: {
            evm: account,
            solana: solanaKeypair || undefined
        }
    });

    console.log("Checking Credits Balance for:", account.address);
    // Use raw fetch to see full body
    const resp = await fetch(`${config.conwayApiUrl}/v1/credits/balance`, {
        headers: { "Authorization": apiKey }
    });
    console.log("Status:", resp.status);
    console.log("Headers:", JSON.stringify(Object.fromEntries(resp.headers.entries())));
    const body = await resp.json();
    console.log("Body:", JSON.stringify(body, null, 2));
}

diag().catch(console.error);
