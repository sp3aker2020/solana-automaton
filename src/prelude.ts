
// This file must be imported before any other imports in index.ts
// to ensure environment variables are set before other modules initialize.

// Bypass SSL certificate validation for inference.conway.tech (Railway edge issue)
process.env.NODE_TLS_REJECT_UNAUTHORIZED = "0";
