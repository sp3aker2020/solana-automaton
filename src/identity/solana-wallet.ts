/**
 * Automaton Solana Wallet Management
 *
 * Creates and manages a Solana wallet for the automaton's actions.
 * The private key is stored as a JSON array of bytes (standard Solana format).
 */

import { Keypair } from "@solana/web3.js";
import fs from "fs";
import path from "path";
import { getAutomatonDir } from "./wallet.js";

const SOLANA_WALLET_FILE = path.join(getAutomatonDir(), "solana-wallet.json");

/**
 * Get or create the automaton's Solana wallet.
 */
export async function getSolanaWallet(): Promise<{
    keypair: Keypair;
    isNew: boolean;
}> {
    const dir = getAutomatonDir();
    if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    }

    if (fs.existsSync(SOLANA_WALLET_FILE)) {
        const secretKeyString = fs.readFileSync(SOLANA_WALLET_FILE, "utf-8");
        const secretKey = Uint8Array.from(JSON.parse(secretKeyString));
        const keypair = Keypair.fromSecretKey(secretKey);
        return { keypair, isNew: false };
    } else {
        const keypair = Keypair.generate();
        const secretKeyArray = Array.from(keypair.secretKey);

        fs.writeFileSync(SOLANA_WALLET_FILE, JSON.stringify(secretKeyArray), {
            mode: 0o600,
        });

        return { keypair, isNew: true };
    }
}

/**
 * Get the Solana wallet address (PublicKey) as string.
 */
export async function getSolanaAddress(): Promise<string | null> {
    if (!fs.existsSync(SOLANA_WALLET_FILE)) {
        return null;
    }
    const { keypair } = await getSolanaWallet();
    return keypair.publicKey.toBase58();
}

/**
 * Load the full Solana Keypair (needed for signing).
 */
export async function loadSolanaKeypair(): Promise<Keypair | null> {
    if (!fs.existsSync(SOLANA_WALLET_FILE)) {
        return null;
    }
    const { keypair } = await getSolanaWallet();
    return keypair;
}

export function solanaWalletExists(): boolean {
    return fs.existsSync(SOLANA_WALLET_FILE);
}

/**
 * Get Solana USDC Balance.
 */
export async function getSolanaBalance(address: string): Promise<number> {
    const { getSolanaConnection } = await import("../conway/solana.js");
    const { PublicKey } = await import("@solana/web3.js");
    const connection = getSolanaConnection();
    const pubkey = new PublicKey(address);
    // Find USDC mint
    const USDC_MINT = new PublicKey("EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v");
    const response = await connection.getParsedTokenAccountsByOwner(pubkey, { mint: USDC_MINT });
    if (response.value.length === 0) return 0;
    const balance = response.value[0].account.data.parsed.info.tokenAmount.uiAmount;
    return balance || 0;
}
