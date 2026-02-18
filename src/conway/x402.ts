/**
 * x402 Payment Protocol
 *
 * Enables the automaton to make USDC micropayments via HTTP 402.
 * Adapted from conway-mcp/src/x402/index.ts
 */

import {
  createPublicClient,
  http,
  parseUnits,
  type Address,
  type PrivateKeyAccount,
} from "viem";
import { base, baseSepolia } from "viem/chains";
import {
  Connection,
  PublicKey,
  Transaction,
  SystemProgram,
  Keypair,
  sendAndConfirmTransaction
} from "@solana/web3.js";
import {
  getOrCreateAssociatedTokenAccount,
  createTransferCheckedInstruction,
  TOKEN_PROGRAM_ID
} from "@solana/spl-token";
import { getSolanaConnection, getDevnetConnection } from "./solana.js";

// USDC contract addresses
const USDC_ADDRESSES: Record<string, string> = {
  "eip155:8453": "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913", // Base mainnet
  "eip155:84532": "0x036CbD53842c5426634e7929541eC2318f3dCF7e", // Base Sepolia
  "solana:mainnet": "EPjFW36S7pDe96CcSdr97WkRE8m83952LpUS3o431G1", // Solana Mainnet
  "solana:devnet": "4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU", // Solana Devnet
};

const CHAINS: Record<string, any> = {
  "eip155:8453": base,
  "eip155:84532": baseSepolia,
};

const BALANCE_OF_ABI = [
  {
    inputs: [{ name: "account", type: "address" }],
    name: "balanceOf",
    outputs: [{ name: "", type: "uint256" }],
    stateMutability: "view",
    type: "function",
  },
] as const;

interface PaymentRequirement {
  scheme: string;
  network: string;
  maxAmountRequired: string;
  payToAddress: string;
  requiredDeadlineSeconds: number;
  usdcAddress: string;
}

interface X402PaymentResult {
  success: boolean;
  response?: any;
  error?: string;
}

/**
 * Get the USDC balance for the automaton's wallet on a given network.
 */
export async function getUsdcBalance(
  address: string,
  network: string = "eip155:8453",
): Promise<number> {
  if (network.startsWith("solana")) {
    try {
      const connection = network === "solana:devnet" ? getDevnetConnection() : getSolanaConnection();
      const mint = new PublicKey(USDC_ADDRESSES[network]);
      const owner = new PublicKey(address);

      const { getAssociatedTokenAddress, getAccount } = await import("@solana/spl-token");
      const ata = await getAssociatedTokenAddress(mint, owner);
      const account = await getAccount(connection, ata);

      return Number(account.amount) / 1_000_000;
    } catch {
      return 0;
    }
  }

  const chain = CHAINS[network];
  const usdcAddress = USDC_ADDRESSES[network];
  if (!chain || !usdcAddress) {
    return 0;
  }

  try {
    const client = createPublicClient({
      chain,
      transport: http(),
    });

    const balance = await client.readContract({
      address: usdcAddress as Address,
      abi: BALANCE_OF_ABI,
      functionName: "balanceOf",
      args: [address as Address],
    });

    // USDC has 6 decimals
    return Number(balance) / 1_000_000;
  } catch {
    return 0;
  }
}

/**
 * Check if a URL requires x402 payment.
 */
export async function checkX402(
  url: string,
): Promise<PaymentRequirement | null> {
  try {
    const resp = await fetch(url, { method: "GET" });
    if (resp.status !== 402) {
      return null;
    }

    // Try X-Payment-Required header
    const header = resp.headers.get("X-Payment-Required");
    if (header) {
      const requirements = JSON.parse(
        Buffer.from(header, "base64").toString("utf-8"),
      );
      const accept = requirements.accepts?.[0];
      if (accept) {
        return {
          scheme: accept.scheme,
          network: accept.network,
          maxAmountRequired: accept.maxAmountRequired,
          payToAddress: accept.payToAddress,
          requiredDeadlineSeconds: accept.requiredDeadlineSeconds || 300,
          usdcAddress:
            accept.usdcAddress ||
            USDC_ADDRESSES[accept.network] ||
            USDC_ADDRESSES["eip155:8453"],
        };
      }
    }

    // Try body
    const body = await resp.json().catch(() => null);
    if (body?.accepts?.[0]) {
      const accept = body.accepts[0];
      return {
        scheme: accept.scheme,
        network: accept.network,
        maxAmountRequired: accept.maxAmountRequired,
        payToAddress: accept.payToAddress,
        requiredDeadlineSeconds: accept.requiredDeadlineSeconds || 300,
        usdcAddress:
          accept.usdcAddress ||
          USDC_ADDRESSES[accept.network] ||
          USDC_ADDRESSES["eip155:8453"],
      };
    }

    return null;
  } catch {
    return null;
  }
}

/**
 * Fetch a URL with automatic x402 payment.
 * If the endpoint returns 402, sign and pay, then retry.
 */
export async function x402Fetch(
  url: string,
  accounts: { evm: PrivateKeyAccount; solana?: Keypair },
  method: string = "GET",
  body?: string,
  headers?: Record<string, string>,
): Promise<X402PaymentResult> {
  try {
    // Initial request
    const initialResp = await fetch(url, {
      method,
      headers: { ...headers, "Content-Type": "application/json" },
      body,
    });

    if (initialResp.status !== 402) {
      const data = await initialResp
        .json()
        .catch(() => initialResp.text());
      return { success: initialResp.ok, response: data };
    }

    // Parse payment requirements
    const requirement = await parsePaymentRequired(initialResp);
    if (!requirement) {
      return { success: false, error: "Could not parse payment requirements" };
    }

    // Sign payment based on network
    let payment: any;
    if (requirement.network.startsWith("solana")) {
      if (!accounts.solana) return { success: false, error: "Solana wallet required but not provided" };
      payment = await signSolanaPayment(accounts.solana, requirement);
    } else {
      payment = await signPayment(accounts.evm, requirement);
    }

    if (!payment) {
      return { success: false, error: "Failed to sign payment" };
    }

    // Retry with payment
    const paymentHeader = Buffer.from(
      JSON.stringify(payment),
    ).toString("base64");

    const paidResp = await fetch(url, {
      method,
      headers: {
        ...headers,
        "Content-Type": "application/json",
        "X-Payment": paymentHeader,
      },
      body,
    });

    const data = await paidResp.json().catch(() => paidResp.text());
    return { success: paidResp.ok, response: data };
  } catch (err: any) {
    return { success: false, error: err.message };
  }
}

async function parsePaymentRequired(
  resp: Response,
): Promise<PaymentRequirement | null> {
  const header = resp.headers.get("X-Payment-Required");
  if (header) {
    try {
      const requirements = JSON.parse(
        Buffer.from(header, "base64").toString("utf-8"),
      );
      const accept = requirements.accepts?.[0];
      if (accept) return accept;
    } catch { }
  }

  try {
    const body = await resp.json();
    return body.accepts?.[0] || null;
  } catch {
    return null;
  }
}

async function signPayment(
  account: PrivateKeyAccount,
  requirement: PaymentRequirement,
): Promise<any | null> {
  try {
    const nonce = `0x${Buffer.from(
      crypto.getRandomValues(new Uint8Array(32)),
    ).toString("hex")}`;

    const now = Math.floor(Date.now() / 1000);
    const validAfter = now - 60;
    const validBefore = now + requirement.requiredDeadlineSeconds;

    const amount = parseUnits(requirement.maxAmountRequired, 6);

    // EIP-712 typed data for TransferWithAuthorization
    const domain = {
      name: "USD Coin",
      version: "2",
      chainId: requirement.network === "eip155:84532" ? 84532 : 8453,
      verifyingContract: requirement.usdcAddress as Address,
    } as const;

    const types = {
      TransferWithAuthorization: [
        { name: "from", type: "address" },
        { name: "to", type: "address" },
        { name: "value", type: "uint256" },
        { name: "validAfter", type: "uint256" },
        { name: "validBefore", type: "uint256" },
        { name: "nonce", type: "bytes32" },
      ],
    } as const;

    const message = {
      from: account.address,
      to: requirement.payToAddress as Address,
      value: amount,
      validAfter: BigInt(validAfter),
      validBefore: BigInt(validBefore),
      nonce: nonce as `0x${string}`,
    };

    const signature = await account.signTypedData({
      domain,
      types,
      primaryType: "TransferWithAuthorization",
      message,
    });

    return {
      x402Version: 1,
      scheme: "exact",
      network: requirement.network,
      payload: {
        signature,
        authorization: {
          from: account.address,
          to: requirement.payToAddress,
          value: amount.toString(),
          validAfter: validAfter.toString(),
          validBefore: validBefore.toString(),
          nonce,
        },
      },
    };
  } catch {
    return null;
  }
}
async function signSolanaPayment(
  keypair: Keypair,
  requirement: PaymentRequirement,
): Promise<any | null> {
  try {
    const connection = requirement.network === "solana:devnet" ? getDevnetConnection() : getSolanaConnection();
    const mint = new PublicKey(requirement.usdcAddress);
    const destination = new PublicKey(requirement.payToAddress);
    const amount = Math.floor(parseFloat(requirement.maxAmountRequired) * 1_000_000);

    // For Solana x402, we sign a transaction that transfers USDC
    // but we don't necessarily send it - we return the signed transaction
    // or a specialized payload. However, x402 usually expects an "authorization"
    // that the server can then submit.

    // On Solana, we can use the "Simple Payment" approach: 
    // Return a signed transaction string that the server can broadcast.

    const fromAta = await getOrCreateAssociatedTokenAccount(connection, keypair, mint, keypair.publicKey);
    const toAta = await getOrCreateAssociatedTokenAccount(connection, keypair, mint, destination);

    const transaction = new Transaction().add(
      createTransferCheckedInstruction(
        fromAta.address,
        mint,
        toAta.address,
        keypair.publicKey,
        BigInt(amount),
        6
      )
    );

    const { blockhash } = await connection.getLatestBlockhash();
    transaction.recentBlockhash = blockhash;
    transaction.feePayer = keypair.publicKey;

    transaction.sign(keypair);
    const serializedTransaction = transaction.serialize().toString("base64");

    return {
      x402Version: 1,
      scheme: "exact",
      network: requirement.network,
      payload: {
        transaction: serializedTransaction,
      },
    };
  } catch (err: any) {
    console.error("Solana x402 signing failed:", err);
    return null;
  }
}
