/**
 * Automaton Solana Blockchain Helpers
 */

import { Connection, clusterApiUrl } from "@solana/web3.js";

const DEFAULT_RPC = "https://api.mainnet-beta.solana.com";

/**
 * Get a connection to the Solana network.
 * Defaults to Mainnet but can use Devnet if specified in environment.
 */
export function getSolanaConnection(): Connection {
    const endpoint = process.env.SOLANA_RPC_URL || clusterApiUrl("mainnet-beta");
    return new Connection(endpoint, "confirmed");
}

/**
 * Helper to get a devnet connection for testing.
 */
export function getDevnetConnection(): Connection {
    return new Connection(clusterApiUrl("devnet"), "confirmed");
}
