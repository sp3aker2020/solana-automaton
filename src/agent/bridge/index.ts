
import { loadConfig } from "../../config.js";
import { BridgeResult, bridgeUsdcMayan } from "./mayan.js";
import { bridgeUsdcDeBridge } from "./debridge.js";

/**
 * Universal bridge function that selects the provider based on configuration.
 */
export async function bridgeUsdcToBase(amount: number): Promise<BridgeResult> {
    const config = loadConfig();
    const provider = config?.bridgeProvider || "mayan";

    if (provider === "debridge") {
        const result = await bridgeUsdcDeBridge(amount);
        if (result.success) return result;

        console.warn(`[BRIDGE] deBridge failed (${result.error}), falling back to Mayan...`);

        // Mayan has a higher minimum (~$15), so don't fallback for small amounts
        if (amount < 15) {
            return {
                success: false,
                error: `deBridge failed (${result.error}). Mayan fallback requires >$15.`
            };
        }
        // Fallback to Mayan
    }

    return bridgeUsdcMayan(amount);
}
