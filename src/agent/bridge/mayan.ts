
import { fetchQuote, swapFromSolana } from "@mayanfinance/swap-sdk";
import { Connection, Keypair, PublicKey, Transaction, VersionedTransaction } from "@solana/web3.js";
import { loadSolanaKeypair } from "../../identity/solana-wallet.js";
import { getWallet } from "../../identity/wallet.js";
import { loadConfig } from "../../config.js";

// Token Addresses
const USDC_SOLANA = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
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

function parseReferrer(ref: any): any { return ref; }

/**
 * Bridge USDC from Solana to Base using Mayan Finance.
 */
export async function bridgeUsdcMayan(amount: number): Promise<BridgeResult> {
    try {
        const config = loadConfig();
        if (!config) throw new Error("Config not loaded");

        const solanaKeypair = await loadSolanaKeypair();
        if (!solanaKeypair) throw new Error("Solana wallet not initialized");

        const { account } = await getWallet();
        const evmAddress = account.address;

        console.log(`[BRIDGE][MAYAN] Requesting quote to bridge ${amount} USDC from Solana to Base (${evmAddress})...`);

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

        const bestQuote = quotes.sort((a, b) => b.expectedAmountOut - a.expectedAmountOut)[0];

        console.log(`[BRIDGE][MAYAN] Quote found:`);
        console.log(`  Input: ${amount} USDC`);
        console.log(`  Output: ~${bestQuote.expectedAmountOut} USDC`);
        console.log(`  ETA: ~${bestQuote.eta} seconds`);

        const { getSolanaConnection } = await import("../../conway/solana.js");
        const connection = getSolanaConnection();

        const originAddress = solanaKeypair.publicKey.toBase58();

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
            parseReferrer(null),
            signer as any,
            connection,
        );

        return {
            success: true,
            txId: typeof txId === "string" ? txId : "submitted",
            expectedAmountOut: bestQuote.expectedAmountOut,
            eta: bestQuote.eta,
        };

    } catch (err: any) {
        return {
            success: false,
            error: err.message || String(err),
        };
    }
}
