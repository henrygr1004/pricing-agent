require('dotenv').config();
const express = require('express');
const path = require('path');
const fetch = (...args) => import('node-fetch').then(({ default: f }) => f(...args));

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

const { LINKUP_API_KEY, NEBIUS_API_KEY, NEBIUS_BASE_URL, NEBIUS_MODEL, TENKI_API_KEY, REVENUECAT_API_KEY, REVENUECAT_PROJECT_ID } = process.env;

// STEP 1 — Research: ask LinkUp for competitor pricing info
async function researchCompetitors(product) {
  const res = await fetch('https://api.linkup.so/v1/search', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${LINKUP_API_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      q: `pricing plans and cost of ${product} and its main competitors`,
      depth: 'standard',
      outputType: 'sourcedAnswer',
    }),
  });
  if (!res.ok) throw new Error(`LinkUp error: ${res.status} ${await res.text()}`);
  return res.json();
}

// STEP 1b — Research: ask LinkUp what price-increase tolerance is typical for
// this product's industry, so the Tenki safety threshold is a real researched
// number instead of a made-up constant.
async function researchPriceTolerance(product) {
  const res = await fetch('https://api.linkup.so/v1/search', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${LINKUP_API_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      q: `What percentage price increase can a SaaS company like ${product} typically implement without causing significant customer churn, according to SaaS pricing research?`,
      depth: 'standard',
      outputType: 'sourcedAnswer',
    }),
  });
  if (!res.ok) throw new Error(`LinkUp error: ${res.status} ${await res.text()}`);
  const data = await res.json();
  const text = data.answer || '';
  const match = text.match(/(\d{1,2})\s?%/);
  const thresholdPct = match ? parseInt(match[1], 10) : 15; // fallback if LinkUp gives no number
  return { thresholdPct, source: text };
}

// STEP 2 — Decision: send research to a model hosted on Nebius
async function decidePricing(product, researchSummary) {
  const res = await fetch(`${NEBIUS_BASE_URL}/chat/completions`, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${NEBIUS_API_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model: NEBIUS_MODEL,
      messages: [
        {
          role: 'system',
          content: 'You are a SaaS pricing strategist. Given competitor research, respond ONLY with JSON: {"suggested_price": number, "currency": "USD", "reasoning": "short string"}',
        },
        {
          role: 'user',
          content: `Product: ${product}\nCompetitor research:\n${researchSummary}`,
        },
      ],
      temperature: 0.2,
    }),
  });
  if (!res.ok) throw new Error(`Nebius error: ${res.status} ${await res.text()}`);
  const data = await res.json();
  const content = data.choices[0].message.content;
  return JSON.parse(content);
}

// STEP 2.5 — Validate: run a quick sanity-check simulation in an isolated Tenki sandbox
// before the decision is allowed to touch anything real.
async function validateInSandbox(decision, thresholdPct) {
  const { TenkiSandbox } = await import('@tenkicloud/sandbox');
  const sandbox = new TenkiSandbox({ apiKey: TENKI_API_KEY });

  const session = await sandbox.createAndWait({ cpuCores: 1, memoryMb: 1024 });
  try {
    // A tiny, disposable script that sanity-checks the AI's price suggestion
    // against a mock current-price baseline before it's trusted to act.
    // The threshold itself comes from LinkUp's industry research, not a guess.
    // Written and run inline via bash so we only depend on session.exec,
    // which is the one method confirmed by Tenki's own docs.
    const jsCode = `
const decision = ${JSON.stringify(decision)};
const thresholdPct = ${thresholdPct};
const currentPrice = 10; // mock baseline; swap for a real lookup later
const delta = (decision.suggested_price - currentPrice) / currentPrice;
const passed = Math.abs(delta) <= (thresholdPct / 100);
console.log(JSON.stringify({ passed, delta_pct: Math.round(delta * 100), threshold_pct: thresholdPct }));
`.trim();

    const bashCmd = `cat > check.js << 'SCRIPTEOF'\n${jsCode}\nSCRIPTEOF\nnode check.js`;
    const result = await session.exec('bash', { args: ['-lc', bashCmd] });
    let stdoutText;
    if (typeof result.stdout === 'string') {
      stdoutText = result.stdout;
    } else {
      // stdout came back as a Uint8Array (not a Node Buffer), so decode it explicitly
      // instead of relying on its default Array-like toString().
      stdoutText = new TextDecoder('utf-8').decode(result.stdout);
    }
    const jsonMatch = stdoutText.match(/\{[\s\S]*\}/);
    if (!jsonMatch) {
      throw new Error(`Sandbox produced no JSON output. Raw stdout: ${stdoutText.slice(0, 300)}`);
    }
    return JSON.parse(jsonMatch[0]);
  } finally {
    await session.close?.();
  }
}

// STEP 3 — Action: push the new price into RevenueCat as an Offering/Package update
async function applyPricingToRevenueCat(decision) {
  const res = await fetch(
    `https://api.revenuecat.com/v2/projects/${REVENUECAT_PROJECT_ID}/offerings`,
    {
      method: 'GET',
      headers: { 'Authorization': `Bearer ${REVENUECAT_API_KEY}` },
    }
  );
  if (!res.ok) throw new Error(`RevenueCat error: ${res.status} ${await res.text()}`);
  const offerings = await res.json();
  // For the demo: return the current offerings + the price we WOULD apply.
  // Actually creating/updating packages requires product IDs already set up in RevenueCat's
  // dashboard (App Store/Play Store linked products) — do that setup once beforehand,
  // then swap this GET for a POST/PATCH to /packages using a real product_id.
  return { offerings, applied_price: decision.suggested_price };
}

app.post('/api/run-pipeline', async (req, res) => {
  const { product } = req.body;
  if (!product) return res.status(400).json({ error: 'product is required' });

  try {
    const research = await researchCompetitors(product);
    const researchSummary = research.answer || JSON.stringify(research).slice(0, 4000);

    const tolerance = await researchPriceTolerance(product);

    // Research and decision are identical either way — only the validation
    // step differs — so we compute them once and branch after.
    const decision = await decidePricing(product, researchSummary);

    // Branch A: real Tenki Sandbox validation gates the action.
    const validation = await validateInSandbox(decision, tolerance.thresholdPct);
    const withValidation = validation.passed === false
      ? { validation, action: null, blocked: true }
      : { validation, action: await applyPricingToRevenueCat(decision), blocked: false };

    // Branch B: DEMO ONLY — bypasses the safety check entirely, applying the
    // same decision straight to RevenueCat regardless of risk.
    const withoutValidation = {
      validation: { skipped: true },
      action: await applyPricingToRevenueCat(decision),
      blocked: false,
    };

    res.json({ product, research: researchSummary, tolerance, decision, withValidation, withoutValidation });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

app.get('/health', (req, res) => res.json({ ok: true }));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
