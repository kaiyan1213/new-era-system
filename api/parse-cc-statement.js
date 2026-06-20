import pdfParse from 'pdf-parse/lib/pdf-parse.js';

// Auto-categorizes credit card statement transactions for the P&L Costs
// system. Ad spend and gifts (and other recurring business expenses) are
// paid via company credit card, so instead of manually re-typing every line
// from the monthly statement into "Add Cost Entry", this endpoint extracts
// the PDF text and asks Claude to structure + categorize every transaction
// in one pass — bank statement layouts vary too much (Maybank/CIMB/Public
// Bank/Amex all format differently) for a regex-only approach to hold up.
//
// Requires an ANTHROPIC_API_KEY environment variable set in the Vercel
// project (Project Settings → Environment Variables). Without it, this
// endpoint returns a clear error rather than failing silently.

const CATEGORIES = ['ad_spend', 'gift', 'staff_pay', 'rental', 'admin', 'wifi', 'utilities', 'team_building', 'cleaning', 'other'];
const CHANNELS = ['DM', 'TM', 'XHS', 'OTHER', 'SHARED'];
const TEAMS = ['New Era', 'Alpha C', null];

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const { base64, debug } = req.body;
  if (!base64) return res.status(400).json({ error: 'No PDF data' });

  if (!process.env.ANTHROPIC_API_KEY) {
    return res.status(500).json({
      error: 'ANTHROPIC_API_KEY is not set on this Vercel project. Go to Vercel → Project Settings → Environment Variables, add ANTHROPIC_API_KEY, then redeploy.'
    });
  }

  try {
    const buffer = Buffer.from(base64, 'base64');
    const pdfData = await pdfParse(buffer);
    const text = pdfData.text;
    if (debug) return res.status(200).json({ success: true, raw_text: text.substring(0, 12000) });

    // Cap the text we send — most statements are 1-3 pages of transactions;
    // this is generous headroom while keeping the request fast and cheap.
    const trimmedText = text.length > 18000 ? text.slice(0, 18000) : text;

    const prompt = `You are extracting transactions from a Malaysian credit card statement (raw PDF text dump below — column alignment may be lost, dates/descriptions/amounts may run together).

For EVERY individual purchase/charge transaction (skip "PAYMENT RECEIVED", "TOTAL DUE", opening/closing balance lines, and statement boilerplate — but DO include interest/late fees as category "other"), extract:
- date: as written in the statement (e.g. "15/06" or "15 JUN")
- description: the merchant name, cleaned up (strip card masking digits, trailing reference numbers)
- amount: positive number, MYR, no currency symbol or commas

Then classify each transaction:
- category: pick the SINGLE best match from this exact list: ${JSON.stringify(CATEGORIES)}
  - "ad_spend" = Facebook/Meta/Google/TikTok ads, boosted posts, marketing platforms
  - "gift" = gift cards, flowers, hampers, retail purchases that read like client/staff gifts
  - "team_building" = restaurants, karaoke, team outings, events
  - "wifi" = internet/telco/broadband providers
  - "utilities" = electricity (TNB), water board
  - "rental" = property/office rental payments
  - "cleaning" = cleaning services
  - "staff_pay" = anything reading like a salary/payroll transfer
  - "admin" = office supplies, stationery, software subscriptions, bank fees
  - "other" = anything that doesn't clearly fit above
- channel: pick from ${JSON.stringify(CHANNELS)} — only guess DM/TM/XHS if the merchant description clearly hints at one specific sales channel (rare); otherwise default "SHARED"
- company_team: pick from ${JSON.stringify(TEAMS)} (use JSON null, not the string "null") — only guess "New Era" or "Alpha C" if the description clearly hints at one specific team; otherwise null (shared/unknown, the user will assign it manually)

Respond with ONLY a raw JSON array, no markdown code fences, no commentary, no leading/trailing text. Format:
[{"date":"15/06","description":"FACEBK *ADS8X7Y2Z","amount":450.00,"category":"ad_spend","channel":"SHARED","company_team":null}]

Statement text:
${trimmedText}`;

    const claudeResp = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'x-api-key': process.env.ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01',
        'content-type': 'application/json'
      },
      body: JSON.stringify({
        model: 'claude-sonnet-4-6',
        max_tokens: 8000,
        messages: [{ role: 'user', content: prompt }]
      })
    });

    if (!claudeResp.ok) {
      const errBody = await claudeResp.text();
      return res.status(502).json({ error: `Claude API error (${claudeResp.status}): ${errBody.slice(0,300)}` });
    }

    const claudeData = await claudeResp.json();
    let raw = (claudeData.content || []).map(b => b.text || '').join('').trim();
    // Strip markdown code fences if Claude added them despite instructions
    raw = raw.replace(/^```json\s*/i, '').replace(/^```\s*/i, '').replace(/```\s*$/i, '').trim();

    let transactions;
    try {
      transactions = JSON.parse(raw);
    } catch(parseErr) {
      return res.status(502).json({ error: 'Could not parse Claude\'s response as JSON. Raw response: ' + raw.slice(0, 500) });
    }

    if (!Array.isArray(transactions)) {
      return res.status(502).json({ error: 'Claude did not return a JSON array.' });
    }

    // Sanity-clean each row — never trust external input blindly
    const cleaned = transactions
      .filter(t => t && typeof t.amount === 'number' && t.amount > 0 && t.description)
      .map(t => ({
        date: String(t.date || '').slice(0, 20),
        description: String(t.description || '').slice(0, 200),
        amount: Math.round(t.amount * 100) / 100,
        category: CATEGORIES.includes(t.category) ? t.category : 'other',
        channel: CHANNELS.includes(t.channel) ? t.channel : 'SHARED',
        company_team: (t.company_team === 'New Era' || t.company_team === 'Alpha C') ? t.company_team : null
      }));

    const total = Math.round(cleaned.reduce((s,t) => s + t.amount, 0) * 100) / 100;

    return res.status(200).json({ success: true, transactions: cleaned, total, count: cleaned.length });
  } catch(e) {
    return res.status(500).json({ error: e.message });
  }
}
