
import { Connection, Keypair, PublicKey, VersionedTransaction } from "@solana/web3.js";
import { loadSolanaKeypair } from "../../identity/solana-wallet.js";
import { getWallet } from "../../identity/wallet.js";
import { loadConfig } from "../../config.js";
import { BridgeResult } from "./mayan.js";

// Token Addresses
const USDC_SOLANA = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
const USDC_BASE = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";

const CHAIN_ID_SOLANA = "7565164"; // deBridge Chain ID for Solana
const CHAIN_ID_BASE = "8453";      // deBridge Chain ID for Base

/**
 * Bridge USDC from Solana to Base using deBridge (DLN).
 */
export async function bridgeUsdcDeBridge(amount: number): Promise<BridgeResult> {
    try {
        const config = loadConfig();
        if (!config) throw new Error("Config not loaded");

        const solanaKeypair = await loadSolanaKeypair();
        if (!solanaKeypair) throw new Error("Solana wallet not initialized");

        const { account } = await getWallet();
        const evmAddress = account.address;

        console.log(`[BRIDGE][DEBRIDGE] Requesting order for ${amount} USDC from Solana to Base (${evmAddress})...`);

        // Step 1: Create Order Transaction via DLN API
        const createTxUrl = `https://api.dln.trade/v1.0/chain/transaction`;

        // deBridge uses 6 decimals for USDC on Solana
        const amountUnits = (amount * 1_000_000).toFixed(0);

        const body = {
            srcChainId: CHAIN_ID_SOLANA,
            srcChainTokenIn: USDC_SOLANA,
            srcChainTokenInAmount: amountUnits,
            dstChainId: CHAIN_ID_BASE,
            dstChainTokenOut: USDC_BASE,
            dstChainTokenOutAmount: "auto", // deBridge will calculate
            dstChainTokenOutRecipient: evmAddress,
            srcChainOrderAuthorityAddress: solanaKeypair.publicKey.toBase58(),
            dstChainOrderAuthorityAddress: evmAddress,
            affiliateFeePercent: "0",
            prependOperatingExpenses: true, // Handle gas on destination
        };

        const response = await fetch(createTxUrl, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(body),
        });

        if (!response.ok) {
            const errText = await response.text();
            throw new Error(`deBridge API error: ${response.status} ${errText}`);
        }

        const data = await response.json();
        if (!data.tx || !data.tx.data) {
            throw new Error("Invalid response from deBridge API: missing tx data");
        }

        // data.tx.data is the base64 encoded serialized transaction
        const txBuffer = Buffer.from(data.tx.data, "base64");

        // Step 2: Sign and Send Transaction
        const { getSolanaConnection } = await import("../../conway/solana.js");
        const connection = getSolanaConnection();

        const transaction = VersionedTransaction.deserialize(txBuffer);

        // Update blockhash to be fresh
        const { blockhash } = await connection.getLatestBlockhash();
        transaction.message.recentBlockhash = blockhash;

        transaction.sign([solanaKeypair]);

        const signature = await connection.sendTransaction(transaction);

        console.log(`[BRIDGE][DEBRIDGE] Order submitted! Signature: ${signature}`);

        return {
            success: true,
            txId: signature,
            expectedAmountOut: data.estimation?.dstChainTokenOut?.amount
                ? Number(data.estimation.dstChainTokenOut.amount) / 1_000_000
                : undefined,
        };

    } catch (err: any) {
        return {
            success: false,
            error: err.message || String(err),
        };
    }
}
