
import { loadConfig } from "../src/config.js";

async function probe() {
    const config = loadConfig();
    const apiKey = config.conwayApiKey;
    const baseUrl = "https://api.conway.tech";

    const endpoints = [
        "/v1/credits/buy",
        "/v1/credits/purchase",
        "/v1/credits/topup",
        "/v1/billing/topup",
        "/v1/user/topup",
        "/v1/payments/create",
    ];

    console.log(`Probing endpoints at ${baseUrl}...`);

    for (const path of endpoints) {
        try {
            const resp = await fetch(`${baseUrl}${path}`, {
                method: "POST",
                headers: {
                    "Content-Type": "application/json",
                    Authorization: apiKey || "",
                },
                body: JSON.stringify({ amount_cents: 100 }), // Try to buy $1
            });

            console.log(`${path} -> ${resp.status} ${resp.statusText}`);
            if (resp.status === 402) {
                console.log(`🎉 FOUND IT! ${path} requires payment (402). This is likely the purchase endpoint.`);
                const data = await resp.json();
                console.log("Response body:", JSON.stringify(data, null, 2));
            } else if (resp.ok) {
                console.log(`✅ ${path} returned 200 OK!`);
                const data = await resp.json();
                console.log("Response body:", JSON.stringify(data, null, 2));
            }
        } catch (err: any) {
            console.log(`${path} -> Error: ${err.message}`);
        }
    }
}

probe().catch(console.error);
