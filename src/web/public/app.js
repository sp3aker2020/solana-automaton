
// State Management
let currentData = null;
let currentStep = 1;

async function updateDashboard() {
    try {
        const response = await fetch('/api/status');
        const result = await response.json();

        if (result.success) {
            const data = result.data;
            if (data.state === 'setup_required') {
                showSetupWizard();
            } else {
                hideSetupWizard();
                renderStatus(data);
            }
            currentData = data;
        } else {
            setOffline();
        }
    } catch (err) {
        setOffline();
    }
}

function showSetupWizard() {
    document.getElementById('setup-wizard').classList.remove('hidden');
}

function hideSetupWizard() {
    document.getElementById('setup-wizard').classList.add('hidden');
}

// Wizard Navigation
function wizardNext() {
    if (!validateStep(currentStep)) return;

    document.getElementById(`wizard-step-${currentStep}`).classList.add('hidden');
    currentStep++;
    document.getElementById(`wizard-step-${currentStep}`).classList.remove('hidden');
    updateWizardDots();
}

function wizardPrev() {
    document.getElementById(`wizard-step-${currentStep}`).classList.add('hidden');
    currentStep--;
    document.getElementById(`wizard-step-${currentStep}`).classList.remove('hidden');
    updateWizardDots();
}

function updateWizardDots() {
    const dots = document.querySelectorAll('.dot');
    dots.forEach((dot, idx) => {
        if (idx + 1 === currentStep) dot.classList.add('active');
        else dot.classList.remove('active');
    });
}

function validateStep(step) {
    if (step === 1) {
        const name = document.getElementById('setup-name').value;
        const genesis = document.getElementById('setup-genesis').value;
        if (!name || !genesis) {
            alert("Please provide both a name and a genesis prompt.");
            return false;
        }
    }
    return true;
}

async function submitSetup() {
    const launchBtn = document.getElementById('launch-btn');
    launchBtn.disabled = true;
    launchBtn.innerText = "INITIALIZING...";

    const setupData = {
        name: document.getElementById('setup-name').value,
        genesisPrompt: document.getElementById('setup-genesis').value,
        bridgeProvider: document.getElementById('setup-provider').value,
        autoBridgeRefill: document.getElementById('setup-auto-refill').checked,
        creatorSolanaAddress: document.getElementById('setup-creator-sol').value,
        creatorAddress: document.getElementById('setup-creator-eth').value
    };

    try {
        const response = await fetch('/api/setup', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(setupData)
        });

        const result = await response.json();
        if (result.success) {
            // Success! Reload after a short delay
            setTimeout(() => {
                window.location.reload();
            }, 2000);
        } else {
            alert("Setup failed: " + result.error);
            launchBtn.disabled = false;
            launchBtn.innerText = "LAUNCH AGENT";
        }
    } catch (err) {
        alert("Network error during setup.");
        launchBtn.disabled = false;
        launchBtn.innerText = "LAUNCH AGENT";
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

// ─── Top Up Modal Logic ──────────────────────────────────────────

function openTopUpModal() {
    document.getElementById('topup-modal').classList.remove('hidden');
    selectAmount(10); // Default
}

function closeTopUpModal() {
    document.getElementById('topup-modal').classList.add('hidden');
}

function selectAmount(val) {
    document.getElementById('topup-amount').value = val;
    // Update visual selection
    const btns = document.querySelectorAll('.btn-amount');
    btns.forEach(b => {
        if (b.innerText.includes(val)) b.classList.add('active');
        else b.classList.remove('active');
    });
}

async function submitTopUp() {
    const amount = document.getElementById('topup-amount').value;
    const btn = document.getElementById('bridge-btn');

    if (!amount || amount < 2) {
        alert("Minimum top-up is $2 USDC.");
        return;
    }

    btn.disabled = true;
    btn.innerText = "BRIDGING...";

    try {
        const response = await fetch('/api/bridge-credits', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ amount: parseFloat(amount) })
        });

        const result = await response.json();

        if (result.success) {
            alert(result.message);
            closeTopUpModal();
        } else {
            alert("Bridge Failed: " + result.error);
        }
    } catch (err) {
        alert("Network error: " + err.message);
    } finally {
        btn.disabled = false;
        btn.innerText = "BRIDGE FUNDS";
    }
}

// Initial Boot
console.log("Conway SOLAUTO Dashboard: Port 18888 Link Established");
updateDashboard();
setInterval(updateDashboard, 15000);
