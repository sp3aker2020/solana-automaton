
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
        return bridgeUsdcDeBridge(amount);
    }

    return bridgeUsdcMayan(amount);
}
