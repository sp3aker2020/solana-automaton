
/**
 * Solana Bridge Utility using Mayan Finance
 * 
 * Enables the automaton to "self-bridge" funds from Solana to Base to satisfy
 * server-side payment requirements.
 */

import { fetchQuote, swapFromSolana, Quote } from "@mayanfinance/swap-sdk";
import { Connection, Keypair, PublicKey, Transaction, VersionedTransaction } from "@solana/web3.js";
import { getSolanaAddress, loadSolanaKeypair } from "../identity/solana-wallet.js";

function parseReferrer(ref: any): any { return ref; }
import { getWallet } from "../identity/wallet.js";
import { loadConfig } from "../config.js";

// Token Addresses
// USDC on Solana (SPL)
const USDC_SOLANA = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
// USDC on Base (ERC20)
const USDC_BASE = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";

const CHAIN_SOLANA = "solana";
const CHAIN_BASE = "base";

export interface BridgeResult {
    success: boolean;
    txId?: string;
    expectedAmountOut?: number;
    eta?: number;
    error?: string;
}

/**
 * A minimal Wallet Adapter for Mayan SDK usage in Node.js
 */
/**
 * A minimal Wallet Adapter for Mayan SDK usage in Node.js
 */
class NodeWalletAdapter {
    publicKey: PublicKey;

    constructor(private keypair: Keypair) {
        this.publicKey = keypair.publicKey;
    }

    async signTransaction(tx: Transaction): Promise<Transaction> {
        tx.partialSign(this.keypair);
        return tx;
    }

    async signAllTransactions(txs: Transaction[]): Promise<Transaction[]> {
        for (const tx of txs) {
            tx.partialSign(this.keypair);
        }
        return txs;
    }
}


/**
 * Bridge USDC from Solana to Base.
 * @param amount Amount in USDC (e.g. 1.5 for $1.50)
 */
export async function bridgeUsdcToBase(amount: number): Promise<BridgeResult> {
    try {
        const config = loadConfig();
        if (!config) throw new Error("Config not loaded");

        // Load wallets
        const solanaKeypair = await loadSolanaKeypair();
        if (!solanaKeypair) throw new Error("Solana wallet not initialized");

        const { account } = await getWallet();
        const evmAddress = account.address; // Destination address on Base

        console.log(`[BRIDGE] Requesting quote to bridge ${amount} USDC from Solana to Base (${evmAddress})...`);

        // Step 1: Get Quote
        const quotes = await fetchQuote({
            amount: amount,
            fromToken: USDC_SOLANA,
            toToken: USDC_BASE,
            fromChain: CHAIN_SOLANA,
            toChain: CHAIN_BASE,
            slippageBps: 100, // 1%
            gasDrop: 0.005, // Optional gas drop
        });

        if (!quotes || quotes.length === 0) {
            throw new Error("No route found for bridging USDC.");
        }

        // Sort by output amount descending
        const bestQuote = quotes.sort((a, b) => b.expectedAmountOut - a.expectedAmountOut)[0];

        // Access properties safely as they might differ in SDK versions
        const providerName = (bestQuote as any).provider || "Mayan";

        console.log(`[BRIDGE] Quote found via ${providerName}:`);
        console.log(`  Input: ${amount} USDC (Solana)`);
        console.log(`  Output: ~${bestQuote.expectedAmountOut} USDC (Base)`);
        console.log(`  ETA: ~${bestQuote.eta} seconds`);
        console.log(`  Gas Drop: ${bestQuote.gasDrop} ETH`);

        // Step 2: Execute Swap
        const { getSolanaConnection } = await import("../conway/solana.js");
        const connection = getSolanaConnection();

        // swapFromSolana(quote, originAddress, destinationAddress, referrerAddresses, signer, connection, options)

        const originAddress = solanaKeypair.publicKey.toBase58();

        // Create a signer function that handles both Transaction and VersionedTransaction
        const signer = async (tx: Transaction | VersionedTransaction): Promise<Transaction | VersionedTransaction> => {
            if (tx instanceof VersionedTransaction) {
                tx.sign([solanaKeypair]);
            } else {
                tx.partialSign(solanaKeypair);
            }
            return tx;
        };

        const txId = await swapFromSolana(
            bestQuote,
            originAddress,
            evmAddress,
            parseReferrer(null), // referrerAddresses 
            signer as any, // Bypass strict type check
            connection,    // connection
        );

        console.log(`[BRIDGE] Swap submitted! Tx ID: ${txId}`);

        return {
            success: true,
            txId: typeof txId === "string" ? txId : "submitted",
            expectedAmountOut: bestQuote.expectedAmountOut,
            eta: bestQuote.eta,
        };

    } catch (err: any) {
        console.error(`[BRIDGE] Error: ${err.message}`);
        return {
            success: false,
            error: err.message || String(err),
        };
    }
}
