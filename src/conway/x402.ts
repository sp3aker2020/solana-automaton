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
} from "@solana/spl-token";
import { getSolanaConnection, getDevnetConnection } from "./solana.js";

// USDC contract addresses
const USDC_ADDRESSES: Record<string, string> = {
  "eip155:8453": "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913", // Base mainnet
  "eip155:84532": "0x036CbD53842c5426634e7929541eC2318f3dCF7e", // Base Sepolia
  "solana:mainnet": "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v", // Solana Mainnet
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

export interface PaymentRequirement {
  scheme: string;
  network: string;
  maxAmountRequired: string;
  payToAddress: string;
  requiredDeadlineSeconds: number;
  usdcAddress: string;
  rawAccept?: any;  // Original v2 accept object for building the payment envelope
}

export interface X402PaymentResult {
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

      try {
        const account = await getAccount(connection, ata);
        return Number(account.amount) / 1_000_000;
      } catch (err: any) {
        // If the token account doesn't exist yet, balance is 0
        if (err.name === "TokenAccountNotFoundError" || err.name === "TokenInvalidAccountOwnerError") {
          return 0;
        }
        throw err;
      }
    } catch (err: any) {
      if (network.startsWith("solana") && err.name !== "TokenAccountNotFoundError") {
        console.error(`[SOLANA] Balance fetch error (${network}): ${err.message}`);
      }
      return 0;
    }
  }

  const chain = CHAINS[network];
  const usdcAddress = USDC_ADDRESSES[network];
  if (!chain || !usdcAddress) {
    return 0;
  }

  try {
    // Verify chain and address
    console.log(`[X402] Checking USDC balance for ${address} on ${network}`);

    const transport = network === "eip155:8453"
      ? http("https://base.publicnode.com")
      : http();

    const client = createPublicClient({
      chain,
      transport,
    });

    const balance = await client.readContract({
      address: usdcAddress as Address,
      abi: BALANCE_OF_ABI,
      functionName: "balanceOf",
      args: [address as Address],
    });

    console.log(`[X402] Balance: ${balance} (${Number(balance) / 1_000_000} USDC)`);

    // USDC has 6 decimals
    return Number(balance) / 1_000_000;
  } catch (err: any) {
    console.error(`[X402] getUsdcBalance failed (${network}): ${err.message}`);
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
      try {
        const rawBody = Buffer.from(header, "base64");
        const text = rawBody.toString("utf-8");
        if (text.startsWith("{")) {
          const requirements = JSON.parse(text);
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
      } catch (e) {
        // Fall back to body
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
    // Initial request - hint that we support Solana!
    const initialResp = await fetch(url, {
      method,
      headers: {
        ...headers,
        "Content-Type": "application/json",
        "X-Accept-Payment": "solana:mainnet, eip155:8453"
      },
      body,
      signal: AbortSignal.timeout(30000), // 30s timeout
    });

    if (initialResp.status !== 402) {
      const data = await initialResp.json().catch(() => null);
      const text = data ? JSON.stringify(data) : await initialResp.text().catch(() => "Unknown error");
      return {
        success: initialResp.ok,
        response: data,
        error: initialResp.ok ? undefined : `HTTP ${initialResp.status}: ${text}`
      };
    }

    // Parse payment requirements
    const requirement = await parsePaymentRequired(initialResp, accounts);
    if (!requirement) {
      return { success: false, error: "Could not parse payment requirements" };
    }

    // Sign payment based on network
    let payment: any;
    if (requirement.network.startsWith("solana")) {
      if (!accounts.solana) return { success: false, error: "Solana wallet required but not provided" };
      payment = await signSolanaPayment(accounts.solana, requirement);
    } else {
      payment = await signPayment(accounts.evm, requirement, url, method);
    }

    if (!payment) {
      return { success: false, error: "Failed to sign payment (check logs)" };
    }

    // Retry with payment — send both v1 and v2 header names for compatibility
    const paymentHeader = Buffer.from(
      JSON.stringify(payment),
    ).toString("base64");
    console.log(`[X402] Sending payment header (${paymentHeader.length} chars, v${payment.x402Version || 1})`);

    const paidResp = await fetch(url, {
      method,
      headers: {
        ...headers,
        "Content-Type": "application/json",
        "X-Payment": paymentHeader,
        "PAYMENT-SIGNATURE": paymentHeader,
      },
      body,
    });

    const data = await paidResp.json().catch(() => paidResp.text());

    // If it's still 402, something went wrong with the payment (insufficient balance etc)
    if (paidResp.status === 402) {
      return {
        success: false,
        response: data,
        error: `HTTP 402: ${typeof data === 'string' ? data : JSON.stringify(data)}`
      };
    }

    return {
      success: paidResp.ok,
      response: data,
      error: paidResp.ok ? undefined : `HTTP ${paidResp.status}: ${typeof data === 'string' ? data : JSON.stringify(data)}`
    };
  } catch (err: any) {
    console.error(`[X402] Fetch failed for ${url}:`, err.message);
    if (err.cause) console.error(`[X402] Cause:`, err.cause);
    return {
      success: false,
      error: `Network error: ${err.message}`,
    };
  }
}

async function parsePaymentRequired(
  resp: Response,
  wallets: { evm: any; solana?: any },
): Promise<PaymentRequirement | null> {
  const header = resp.headers.get("X-Payment-Required");
  let requirements: any = null;

  if (header) {
    try {
      // 1. Try direct JSON parse (standard)
      if (header.trim().startsWith("{")) {
        requirements = JSON.parse(header);
      } else {
        // 2. Fallback: Try Base64 decoding (for some legacy or special proxies)
        const rawBody = Buffer.from(header, "base64");
        const text = rawBody.toString("utf-8");
        if (text.trim().startsWith("{")) {
          requirements = JSON.parse(text);
        } else {
          // It might be a custom string or just garbage
          // log(config, `[X402] Header found but not recognized as JSON.`);
        }
      }
    } catch (err: any) {
      // silent fail for header parse, will try body next
    }
  }

  if (!requirements) {
    try {
      const text = await resp.text();
      try {
        requirements = JSON.parse(text);
      } catch {
        // console.warn(`[X402] 402 response body is not JSON: ${text.slice(0, 100)}`);
        return null;
      }
    } catch (err: any) {
      console.error(`[X402] Error reading response body: ${err.message}`);
      return null;
    }
  }

  if (!requirements || !requirements.accepts) {
    console.warn(`[X402] 402 response missing 'accepts':`, JSON.stringify(requirements));
    return null;
  }

  const accepts = requirements.accepts as any[];
  console.log(`[X402] Server accepts ${accepts.length} payment options: ${accepts.map((a: any) => a.network).join(", ")}`);

  // Normalize v2 fields to our PaymentRequirement interface
  // Keep the raw accept object for building the v2 payment envelope
  const normalize = (accept: any): PaymentRequirement => ({
    scheme: accept.scheme,
    network: accept.network,
    maxAmountRequired: accept.maxAmountRequired,
    payToAddress: accept.payToAddress || accept.payTo,
    requiredDeadlineSeconds: accept.requiredDeadlineSeconds || accept.maxTimeoutSeconds || 300,
    usdcAddress: accept.usdcAddress || accept.asset || USDC_ADDRESSES[accept.network] || USDC_ADDRESSES["eip155:8453"],
    rawAccept: accept,  // Preserve original for v2 envelope
  });

  // Favor Solana if we have a wallet
  for (const accept of accepts) {
    if (accept.network.startsWith("solana:") && wallets.solana) {
      console.log(`[X402] Selected Solana payment path: ${accept.network}`);
      return normalize(accept);
    }
  }

  // Fallback to EVM
  for (const accept of accepts) {
    if (accept.network.startsWith("eip155:") && wallets.evm) {
      console.log(`[X402] Selected EVM payment path: ${accept.network}`);
      return normalize(accept);
    }
  }

  console.warn(`[X402] No compatible wallet found for accepted networks.`);
  return null;
}

export async function signPayment(
  account: PrivateKeyAccount,
  requirement: PaymentRequirement,
  resourceUrl?: string,
  resourceMethod?: string,
): Promise<any | null> {
  try {
    // Use the official @x402/evm SDK for correct payment signing
    const rawAccept = requirement.rawAccept || {};
    const amountStr = requirement.maxAmountRequired || "0";
    console.log(`[X402] Signing payment: ${amountStr} raw units ($${(Number(amountStr) / 1_000_000).toFixed(4)}) to ${requirement.payToAddress}`);

    try {
      const { ExactEvmScheme } = await import("@x402/evm/exact/client");
      const scheme = new ExactEvmScheme(account);

      // Build the v2 requirements object with the field names the SDK expects
      const sdkRequirements = {
        ...rawAccept,
        payTo: requirement.payToAddress || rawAccept.payTo,
        amount: rawAccept.amount || rawAccept.maxAmountRequired || amountStr,
        maxTimeoutSeconds: rawAccept.maxTimeoutSeconds || requirement.requiredDeadlineSeconds || 300,
        asset: requirement.usdcAddress || rawAccept.asset,
        network: requirement.network,
        scheme: "exact",
        extra: rawAccept.extra || { name: "USD Coin", version: "2", assetTransferMethod: "eip3009" },
      };

      const result = await scheme.createPaymentPayload(2, sdkRequirements);
      console.log(`[X402] ✅ Official SDK signed payment successfully`);
      return result;
    } catch (sdkErr: any) {
      console.warn(`[X402] Official SDK failed (${sdkErr.message}), falling back to custom signing`);
    }

    // Fallback: custom signing (matches official SDK format)
    const { getAddress } = await import("viem");
    const nonce = `0x${Buffer.from(
      crypto.getRandomValues(new Uint8Array(32)),
    ).toString("hex")}` as `0x${string}`;

    const now = Math.floor(Date.now() / 1000);
    const validAfter = now - 600; // 10 minutes back (matches official SDK)
    const validBefore = now + (rawAccept.maxTimeoutSeconds || requirement.requiredDeadlineSeconds || 300);

    const amount = BigInt(amountStr);
    const toAddress = getAddress(requirement.payToAddress || rawAccept.payTo) as Address;
    const assetAddress = getAddress(requirement.usdcAddress || rawAccept.asset || USDC_ADDRESSES[requirement.network] || USDC_ADDRESSES["eip155:8453"]) as Address;

    const extra = rawAccept.extra || {};
    if (!extra.name || !extra.version) {
      throw new Error("EIP-712 domain params (name, version) required in payment requirements");
    }

    const chainId = parseInt(requirement.network.split(":")[1]);
    const domain = {
      name: extra.name,
      version: extra.version,
      chainId,
      verifyingContract: assetAddress,
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
      from: getAddress(account.address),
      to: toAddress,
      value: amount,
      validAfter: BigInt(validAfter),
      validBefore: BigInt(validBefore),
      nonce,
    };

    const signature = await account.signTypedData({
      domain,
      types,
      primaryType: "TransferWithAuthorization",
      message,
    });

    return {
      x402Version: 2,
      payload: {
        signature,
        authorization: {
          from: account.address,
          to: toAddress,
          value: amountStr,
          validAfter: validAfter.toString(),
          validBefore: validBefore.toString(),
          nonce,
        },
      },
    };
  } catch (err: any) {
    console.error(`[X402] signPayment failed: ${err.message}`);
    if (err.stack) console.error(err.stack);
    return null;
  }
}

export async function signSolanaPayment(
  keypair: Keypair,
  requirement: PaymentRequirement,
): Promise<any | null> {
  try {
    const connection = requirement.network === "solana:devnet" ? getDevnetConnection() : getSolanaConnection();
    const mint = new PublicKey(requirement.usdcAddress || USDC_ADDRESSES[requirement.network] || USDC_ADDRESSES["solana:mainnet"]);
    const destination = new PublicKey(requirement.payToAddress || (requirement as any).payTo);
    const amountStr = requirement.maxAmountRequired || "0";
    const amount = Math.floor(parseFloat(amountStr) * 1_000_000);

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
    console.error(`[X402] signSolanaPayment failed: ${err.message}`);
    if (err.stack) console.error(err.stack);
    return null;
  }
}
