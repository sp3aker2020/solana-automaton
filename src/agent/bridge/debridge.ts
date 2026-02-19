
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

        const { getSolanaConnection } = await import("../../conway/solana.js");
        const connection = getSolanaConnection();

        // Check USDC Balance
        const { getAssociatedTokenAddress, getAccount } = await import("@solana/spl-token");
        const usdcMint = new PublicKey(USDC_SOLANA);
        const ata = await getAssociatedTokenAddress(usdcMint, solanaKeypair.publicKey);

        try {
            const accountInfo = await getAccount(connection, ata);
            const balance = Number(accountInfo.amount) / 1_000_000;
            if (balance < amount) {
                return {
                    success: false,
                    error: `Insufficient USDC balance. You have ${balance.toFixed(2)} USDC but requested ${amount} USDC.`
                };
            }

            // Check SOL Balance for gas
            const solBalance = await connection.getBalance(solanaKeypair.publicKey);
            if (solBalance < 0.002 * 1e9) {
                return {
                    success: false,
                    error: `Insufficient SOL for gas. You have ${(solBalance / 1e9).toFixed(4)} SOL, but need ~0.002 SOL to power the bridge.`
                };
            }
        } catch (err: any) {
            if (err.name === "TokenAccountNotFoundError") {
                return {
                    success: false,
                    error: `No USDC account found. Please fund your Solana wallet ${solanaKeypair.publicKey.toBase58()} with USDC.`
                };
            }
            throw err;
        }

        console.log(`[BRIDGE][DEBRIDGE] Requesting order for ${amount} USDC from Solana to Base (${evmAddress})...`);

        // Step 1: Create Order Transaction via DLN API
        const createTxUrl = `https://dln.debridge.finance/v1.0/dln/order/create-tx`;

        // deBridge uses 6 decimals for USDC on Solana
        const amountUnits = (amount * 1_000_000).toFixed(0);

        const params = {
            srcChainId: CHAIN_ID_SOLANA,
            srcChainTokenIn: USDC_SOLANA,
            srcChainTokenInAmount: amountUnits,
            dstChainId: CHAIN_ID_BASE,
            dstChainTokenOut: USDC_BASE,
            dstChainTokenOutAmount: "auto",
            dstChainTokenOutRecipient: evmAddress,
            senderAddress: solanaKeypair.publicKey.toBase58(),
            srcChainOrderAuthorityAddress: solanaKeypair.publicKey.toBase58(),
            dstChainOrderAuthorityAddress: evmAddress,
            affiliateFeePercent: "0",
            prependOperatingExpenses: "true",
        };

        const query = new URLSearchParams(params).toString();
        const response = await fetch(`${createTxUrl}?${query}`, {
            method: "GET",
            headers: {
                "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36",
                "Accept": "application/json"
            }
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
