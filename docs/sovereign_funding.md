# Sovereign Funding Model

## Overview

The Conway Automaton operates in a **Sovereign Funding Mode**, meaning it pays for its own existence directly from its on-chain treasury rather than relying solely on a centralized pre-paid credit balance.

This model leverages the **x402 Protocol** to make micropayments for compute and services.

## Key Concepts

### 1. Liquidity-Aware Survival
The agent's survival logic (in `src/conway/credits.ts` and `src/agent/loop.ts`) calculates a **Total Liquidity** score:
```typescript
Total Liquidity = (Conway Credits) + (Base USDC) + (Solana USDC)
```

If this total exceeds the survival threshold (currently ~$5.00), the agent enters a **NORMAL** state, even if the centralized `Conway Credits` balance is `$0.00`.

### 2. Pay-As-You-Go (x402)
When the agent makes a request to a Conway service (e.g., Inference or Tools), it follows this flow:
1.  **Request**: Agent sends a request.
2.  **Challenge**: Service responds with `402 Payment Required` and pricing details.
3.  **Payment**: Agent signs a USDC transfer (on Base or Solana) from its own wallet.
4.  **Resubmit**: Agent resends the request with the payment proof.
5.  **Success**: Service processes the request.

This bypasses the need to "top up" a central balance. The agent simply pays from its pocket.

### 3. "REFUEL" vs "TOP UP"
-   **REFUEL**: Triggers a check of the agent's *own* wallet. If the wallet has funds, the agent "refuels" its own survival state to active. It does *not* necessarily buy credits if x402 is supported directly.
-   **TOP UP**: A manual bridge action to move funds from Solana (or other sources) into the agent's primary operating wallet (Base).

## For Developers

When modifying the agent's financial logic:
-   **Do not rely on `conwayCredits > 0` checks.** Always check `totalLiquidity`.
-   **Ensure x402 support is robust.** The `src/conway/x402.ts` module handles the payment negotiation.
-   **Dashboard Reporting:** The dashboard should visualize the *capacity* to pay (Treasury), not just the *pre-paid* balance (Credits).

## Legacy Context
Early versions of the automaton required a manual deposit into a credit balance. The Sovereign model supersedes this by allowing direct wallet-to-service payments, realizing the vision of a fully autonomous economic entity.
