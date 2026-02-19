// State Management
let currentData = null;
let currentStep = 1;
let lastBalances = null;

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
                trackBalanceChanges(data.balances);
                renderStatus(data);
                fetchPrices(); // Fetch prices after status update
            }
            currentData = data;
        } else {
            setOffline();
        }
    } catch (err) {
        setOffline();
    }
}

function addLog(message, type = 'sys') {
    const stream = document.getElementById('log-stream');
    const p = document.createElement('p');
    p.className = 'log-line';

    // Detect approval request patterns
    if (message.includes("paused to request your approval") ||
        message.includes("[APPROVAL REQUESTED]") ||
        message.includes("Waiting for approval")) {
        p.classList.add('log-attn');
        type = 'attn';
    }

    const time = new Date().toLocaleTimeString([], { hour12: false, hour: '2-digit', minute: '2-digit', second: '2-digit' });
    const prefix = `[${time}] [${type.toUpperCase()}] `;

    p.innerHTML = `<span class="dim">${prefix}</span>${message}`;

    stream.appendChild(p);

    // Keep logs lean (max 50)
    while (stream.children.length > 50) {
        stream.removeChild(stream.firstChild);
    }
}

function trackBalanceChanges(newBalances) {
    if (!lastBalances) {
        lastBalances = { ...newBalances };
        return;
    }

    const changes = [];

    // Check Conway Credits
    if (newBalances.conwayCredits > lastBalances.conwayCredits) {
        changes.push({ msg: `Successfully received $${(newBalances.conwayCredits - lastBalances.conwayCredits).toFixed(2)} Conway Credits.`, type: 'fin' });
    } else if (newBalances.conwayCredits < lastBalances.conwayCredits) {
        changes.push({ msg: `Spent $${(lastBalances.conwayCredits - newBalances.conwayCredits).toFixed(2)} on compute/tools.`, type: 'pay' });
    }

    // Check Solana USDC
    if (newBalances.solanaUsdc > lastBalances.solanaUsdc) {
        changes.push({ msg: `Detected incoming Solana Treasury deposit: +$${(newBalances.solanaUsdc - lastBalances.solanaUsdc).toFixed(2)}`, type: 'fin' });
    } else if (newBalances.solanaUsdc < lastBalances.solanaUsdc) {
        changes.push({ msg: `Treasury withdrawal/payment on Solana: -$${(lastBalances.solanaUsdc - newBalances.solanaUsdc).toFixed(2)}`, type: 'pay' });
    }

    // Check Base USDC
    if (newBalances.baseUsdc > lastBalances.baseUsdc) {
        changes.push({ msg: `Detected incoming Base Treasury deposit: +$${(newBalances.baseUsdc - lastBalances.baseUsdc).toFixed(2)}`, type: 'fin' });
    } else if (newBalances.baseUsdc < lastBalances.baseUsdc) {
        changes.push({ msg: `Treasury withdrawal/payment on Base: -$${(lastBalances.baseUsdc - newBalances.baseUsdc).toFixed(2)}`, type: 'pay' });
    }

    // Log all changes
    changes.forEach(c => addLog(c.msg, c.type));

    lastBalances = { ...newBalances };
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
        if (currentData && currentData.state !== 'running') {
            addLog("Sovereign Mind Activated. Resuming autonomous operations.", "sys");
        }
        pulse.className = 'pulse online';
        statusText.innerText = 'AGENT ACTIVE';
        statusText.style.color = 'white';
    } else if (data.state === 'sleeping') {
        pulse.className = 'pulse online';
        statusText.innerText = 'AGENT SURVIVING (NAP)';
        statusText.style.color = '#9d00ff';
    } else {
        pulse.className = 'pulse offline';
        statusText.innerText = `AGENT ${data.state.toUpperCase()}`;
        statusText.style.color = 'white';
    }

    // Show wake button if sleeping
    const wakeBtn = document.getElementById('wake-btn');
    if (data.state === 'sleeping') {
        wakeBtn.classList.remove('hidden');
    } else {
        wakeBtn.classList.add('hidden');
    }

    // 2. Financials (Animate numbers)
    const totalTreasury = data.balances.baseUsdc + data.balances.solanaUsdc;
    const totalCapacity = data.balances.conwayCredits + totalTreasury;

    animateValue('runtime-capacity', totalCapacity);
    animateValue('credit-balance', data.balances.conwayCredits);
    animateValue('treasury-balance', totalTreasury);

    animateValue('solana-balance', data.balances.solanaUsdc);
    animateValue('solana-sol-balance', data.balances.solanaSol, 4);
    animateValue('base-usdc-balance', data.balances.baseUsdc);
    animateValue('base-eth-balance', data.balances.baseEth, 4); // 4 decimals for ETH

    // Protocol Badge
    const badge = document.getElementById('protocol-badge');
    if (totalTreasury > 0.1) {
        badge.classList.remove('hidden');
    } else {
        badge.classList.add('hidden');
    }

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
    // Step 4: Fueling Core - Check Total Liquidity > $0.10
    const totalLiquidity = data.balances.conwayCredits + data.balances.baseUsdc + data.balances.solanaUsdc;
    if (totalLiquidity > 0.1) step = 4;
    if (data.state === 'running' || data.state === 'sleeping' || data.state === 'active') step = 5;

    const steps = document.querySelectorAll('.step');
    const labels = [
        "Initializing Genesis",
        "Identity Forged",
        "Solana Wallet Armed",
        "Liquidity Detected",
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

function animateValue(id, endValue, decimals = 2) {
    const obj = document.getElementById(id);
    if (!obj) return;
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

        obj.innerText = currentValue.toFixed(decimals);

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
        if (b.getAttribute('data-amount') === String(val)) b.classList.add('active');
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

async function triggerRefuel() {
    console.log("Refueling credits...");
    const btn = event.target;
    const oldText = btn.innerText;
    btn.disabled = true;
    btn.innerText = "FUELING...";

    try {
        const response = await fetch('/api/fund-credits', {
            method: 'POST'
        });
        const result = await response.json();
        if (result.success) {
            console.log("Credits purchased!");
            updateDashboard(); // Refresh immediately
        } else {
            alert("Refuel failed: " + result.error);
        }
    } catch (err) {
        console.error("Refuel failed:", err);
    } finally {
        btn.disabled = false;
        btn.innerText = oldText;
    }
}

async function triggerWake() {
    console.log("Waking agent...");
    try {
        const response = await fetch('/api/wake', {
            method: 'POST'
        });
        const result = await response.json();
        if (result.success) {
            console.log("Agent woken up!");
            updateDashboard(); // Refresh immediately
        }
    } catch (err) {
        console.error("Wake failed:", err);
    }
}

// ─── Chat & Pricing Logic ────────────────────────────────────────

async function sendChat() {
    const input = document.getElementById('chat-input');
    const btn = document.getElementById('send-btn');
    const content = input.value.trim();

    if (!content) return;

    btn.disabled = true;
    btn.innerText = "SND...";

    try {
        const response = await fetch('/api/inbox', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ content })
        });
        const result = await response.json();
        if (result.success) {
            addLog(`Objective received: "${content.slice(0, 30)}${content.length > 30 ? '...' : ''}"`, 'sys');
            input.value = '';
        } else {
            alert("Failed to send: " + result.error);
        }
    } catch (err) {
        alert("Network error: " + err.message);
    } finally {
        btn.disabled = false;
        btn.innerText = "SEND";
    }
}

async function fetchPrices() {
    try {
        const response = await fetch('/api/prices');
        const result = await response.json();
        if (result.success) {
            renderPrices(result.data);
        }
    } catch (err) {
        console.warn("Failed to fetch prices:", err);
    }
}

function renderPrices(data) {
    const table = document.getElementById('pricing-table');
    const header = `<div class="price-row header"><span>Resource</span><span>Rate</span></div>`;
    let rows = '';

    // Model Pricing
    if (data.models && data.models.length > 0) {
        data.models.forEach(m => {
            const avg = (m.pricing.inputPerMillion + m.pricing.outputPerMillion) / 2;
            rows += `<div class="price-row"><span>${m.id} (avg/1M)</span><span>$${avg.toFixed(2)}</span></div>`;
        });
    }

    // Domain Pricing
    if (data.domainTiers) {
        data.domainTiers.forEach(d => {
            rows += `<div class="price-row"><span>${d.tld} registration</span><span>$${(d.registrationPrice / 100).toFixed(2)}</span></div>`;
        });
    }

    table.innerHTML = header + rows;
}

// Initial Boot
console.log("Conway SOLAUTO Dashboard: Port 18888 Link Established");
updateDashboard();
setInterval(updateDashboard, 15000);
