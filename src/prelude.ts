
// This file must be imported before any other imports in index.ts
// to ensure environment variables are set before other modules initialize.
import dns from "node:dns";

// Bypass SSL certificate validation for inference.conway.tech (Railway edge issue)
process.env.NODE_TLS_REJECT_UNAUTHORIZED = "0";

// Force IPv4 to avoid timeouts on dual-stack networks where IPv6 is broken
if (dns.setDefaultResultOrder) {
    dns.setDefaultResultOrder("ipv4first");
}

console.log("[PRELUDE] SSL bypass and IPv4 preference active.");

// Ensure global fetch has reasonable timeouts
// (Node 20+ uses undici internally for fetch)
