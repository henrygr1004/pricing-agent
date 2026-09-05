require('dotenv').config();
const express = require('express');
const path = require('path');
const fetch = (...args) => import('node-fetch').then(({ default: f }) => f(...args));

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

const { LINKUP_API_KEY, NEBIUS_API_KEY, NEBIUS_BASE_URL, NEBIUS_MODEL, REVENUECAT_API_KEY, REVENUECAT_PROJECT_ID } = process.env;

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
  return { offerings, applied_price: decision.suggested_price };
}

app.post('/api/run-pipeline', async (req, res) => {
  const { product } = req.body;
  if (!product) return res.status(400).json({ error: 'product is required' });

  try {
    const research = await researchCompetitors(product);
    const researchSummary = research.answer || JSON.stringify(research).slice(0, 4000);
    const decision = await decidePricing(product, researchSummary);
    const action = await applyPricingToRevenueCat(decision);
    res.json({ product, research: researchSummary, decision, action });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

app.get('/health', (req, res) => res.json({ ok: true }));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
