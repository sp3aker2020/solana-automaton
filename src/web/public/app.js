
// State Management
let currentData = null;

async function updateDashboard() {
    try {
        const response = await fetch('/api/status');
        const result = await response.json();

        if (result.success) {
            const data = result.data;
            renderStatus(data);
            currentData = data;
        } else {
            setOffline();
        }
    } catch (err) {
        setOffline();
    }
}

function setOffline() {
    document.getElementById('status-pulse').className = 'pulse offline';
    document.getElementById('status-text').innerText = 'AGENT OFFLINE';
}

function renderStatus(data) {
    // 1. Header & Identity
    document.getElementById('agent-name').innerText = data.name.toUpperCase();
    document.getElementById('agent-version').innerText = data.version;

    const pulse = document.getElementById('status-pulse');
    const statusText = document.getElementById('status-text');

    if (data.state === 'running') {
        pulse.className = 'pulse online';
        statusText.innerText = 'AGENT ACTIVE';
    } else if (data.state === 'sleeping') {
        pulse.className = 'pulse online';
        statusText.innerText = 'AGENT SURVIVING (NAP)';
        statusText.style.color = '#9d00ff';
    } else {
        pulse.className = 'pulse offline';
        statusText.innerText = `AGENT ${data.state.toUpperCase()}`;
    }

    // 2. Financials (Animate numbers)
    animateValue('credit-balance', data.balances.conwayCredits);
    animateValue('solana-balance', data.balances.solanaUsdc);

    // 3. Wallets
    document.getElementById('solana-address').innerText = data.wallets.solana || 'NOT INITIALIZED';
    document.getElementById('eth-address').innerText = data.wallets.ethereum;

    // 4. Config
    document.getElementById('genesis-prompt').innerText = data.config.genesisPrompt || 'No prompt set.';
    document.getElementById('bridge-provider').innerText = data.config.bridgeProvider || 'mayan';
    document.getElementById('refill-val').innerText = `$${(data.config.bridgeRefillAmount || 0).toFixed(2)}`;

    // 5. Steps Progress Logic
    updateSteps(data);
}

function updateSteps(data) {
    let step = 1;
    if (data.name !== 'Unnamed Agent') step = 2;
    if (data.wallets.solana) step = 3;
    if (data.balances.conwayCredits > 0) step = 4;
    if (data.state === 'running' || data.state === 'sleeping') step = 5;

    const steps = document.querySelectorAll('.step');
    const labels = [
        "Initializing Genesis",
        "Identity Forged",
        "Solana Wallet Armed",
        "Fueling Core",
        "Sovereign Mind Active"
    ];

    steps.forEach((s, idx) => {
        const sNum = idx + 1;
        if (sNum < step) {
            s.className = 'step complete';
            s.innerText = '✓';
        } else if (sNum === step) {
            s.className = 'step active';
            s.innerText = sNum;
            document.getElementById('current-step-label').innerText = labels[idx];
        } else {
            s.className = 'step';
            s.innerText = sNum;
        }
    });
}

function animateValue(id, endValue) {
    const obj = document.getElementById(id);
    const startValue = parseFloat(obj.innerText) || 0;
    if (startValue === endValue) return;

    const duration = 1000;
    const startTime = performance.now();

    function step(currentTime) {
        const elapsed = currentTime - startTime;
        const progress = Math.min(elapsed / duration, 1);

        // Ease out quad
        const easedProgress = progress * (2 - progress);
        const currentValue = startValue + (endValue - startValue) * easedProgress;

        obj.innerText = currentValue.toFixed(2);

        if (progress < 1) {
            requestAnimationFrame(step);
        }
    }
    requestAnimationFrame(step);
}

// Initial Boot
console.log("Sovereign Dashboard: Port 18789 Link Established");
updateDashboard();
setInterval(updateDashboard, 15000);
