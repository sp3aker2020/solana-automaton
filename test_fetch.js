
process.env.NODE_TLS_REJECT_UNAUTHORIZED = "0";

async function testFetch() {
    try {
        console.log("Testing fetch to https://inference.conway.tech/v1/models...");
        const resp = await fetch("https://inference.conway.tech/v1/models", {
            method: "GET",
            headers: {
                "Authorization": "cnwy_k_98QLSHzEAicH5zKQ2tPrF0ah4tFeNiIn"
            }
        });
        console.log("Status:", resp.status);
        const text = await resp.text();
        console.log("Body:", text.slice(0, 100));
    } catch (err) {
        console.error("Fetch failed:", err.message);
        if (err.cause) console.error("Cause:", err.cause);
    }
}

testFetch();
