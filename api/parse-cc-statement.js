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

// Default category set — used only as a fallback when the frontend
// doesn't send its live category list (e.g. a stale cached page). The
// frontend normally sends the user's actual categories (including any
// custom ones they've added via "+ Add New Category…"), so Claude can
// classify into categories that didn't exist when this file was written.
const DEFAULT_CATEGORIES = [
  { slug:'ad_spend', label:'Ad Spend' }, { slug:'ai_tools', label:'AI Tools' },
  { slug:'gift', label:'Gift' }, { slug:'staff_pay', label:'Staff Pay' },
  { slug:'rental', label:'Office Rental' }, { slug:'admin', label:'Admin' },
  { slug:'wifi', label:'Wifi' }, { slug:'utilities', label:'Water & Electric' },
  { slug:'team_building', label:'Team Building' }, { slug:'cleaning', label:'Cleaning Service' },
  { slug:'other', label:'Other' }
];
// Specific classification hints for categories we recognize by slug —
// applied whenever present in the user's live list, custom categories
// just get their label as the hint instead.
const CATEGORY_HINTS = {
  ad_spend: 'Facebook/Meta/Google/TikTok ads, boosted posts, marketing platforms',
  ai_tools: 'AI / SaaS software subscriptions — e.g. Anthropic, OpenAI, ChatGPT, ManyChat, Supabase, Vercel, GitHub, Notion AI, Midjourney, ElevenLabs, Claude, Make.com, Zapier, n8n, or any other AI/automation/dev-tool platform billing',
  gift: 'gift cards, flowers, hampers, retail purchases that read like client/staff gifts. Shopee / Shopee MY Marketplace charges should ALWAYS be classified as gift unless the description clearly indicates otherwise (e.g. explicitly says "ads" or "subscription")',
  team_building: 'restaurants, karaoke, team outings, events',
  wifi: 'internet/telco/broadband providers',
  utilities: 'electricity (TNB), water board',
  rental: 'property/office rental payments',
  cleaning: 'cleaning services',
  staff_pay: 'anything reading like a salary/payroll transfer',
  admin: 'office supplies, stationery, bank fees, NON-AI/SaaS business admin costs (do NOT put software/AI subscriptions here — use "ai_tools" instead if that category exists)',
  other: "anything that doesn't clearly fit any other category — the fallback"
};

const CHANNELS = ['DM', 'TM', 'XHS', 'OTHER', 'SHARED'];
const TEAMS = ['New Era', 'Alpha C', null];

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const { base64, debug, categories } = req.body;
  if (!base64) return res.status(400).json({ error: 'No PDF data' });

  // Use the caller's live category list if provided (array of {slug,label}),
  // otherwise fall back to the built-in defaults above.
  const activeCategories = (Array.isArray(categories) && categories.length > 0) ? categories : DEFAULT_CATEGORIES;
  const categorySlugs = activeCategories.map(c => c.slug);
  const hasOther = categorySlugs.includes('other');

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

    const categoryGuidance = activeCategories
      .map(c => `  - "${c.slug}" (${c.label}) = ${CATEGORY_HINTS[c.slug] || `transactions matching "${c.label}"`}`)
      .join('\n');

    const prompt = `You are extracting transactions from a Malaysian credit card statement (raw PDF text dump below — column alignment may be lost, dates/descriptions/amounts may run together).

For EVERY individual purchase/charge transaction (skip "PAYMENT RECEIVED", "TOTAL DUE", "STATEMENT BALANCE", opening/closing balance lines, statement boilerplate, any transaction marked "CR" at the end of the amount which means credit/refund/payment, and any DuitNow/bank transfer lines — but DO include interest/late fees as a normal transaction), extract:

CRITICAL: If an amount has "CR" after it (e.g. "81.80 CR"), it is a REFUND/CREDIT — set is_credit: true. Payment lines (PAYMENT RECEIVED, DUITNOW TO, etc.) also set is_credit: true.
- date: as written in the statement (e.g. "15/06" or "15 JUN")
- description: the merchant name, cleaned up (strip card masking digits, trailing reference numbers)
- amount: positive number, MYR, no currency symbol or commas
- is_credit: true if this is a refund/credit/payment (amount had "CR" suffix or is a payment line), false otherwise

Then classify each transaction:
- category: pick the SINGLE best match slug from this exact list: ${JSON.stringify(categorySlugs)}
${categoryGuidance}
${hasOther ? '' : '  (if truly nothing fits, pick whichever category is the closest semantic match)'}
- channel: pick from ${JSON.stringify(CHANNELS)} using these STRICT rules:
  * "MANYCHAT" in description → always "DM"
  * "FACEBK", "FACEBOOK", "FB.ME/ADS" in description → always "DM"
  * Shopee/gift transactions → always "DM"
  * AI tools (ANTHROPIC, OPENAI, PADDLE, APPLE.COM/BILL) → "SHARED"
  * Otherwise → "SHARED"
- company_team: pick from ${JSON.stringify(TEAMS)} using these STRICT rules based on which card this statement is from (card owner info is in the statement header):
  * If card name/owner contains "KY ALLIANCE" or "JENNY" → all gift transactions = "Alpha C", all ads = "Alpha C"
  * All other cards (including Carine CIMB, Kai Yan Alliance, Chloe etc) → "New Era" for ads and gift
  * "MANYCHAT" → always "New Era" UNLESS card is KY Alliance
  * AI tools (ANTHROPIC, OPENAI, APPLE, PADDLE) → always null (shared, split 50/50)
  * Gift (Shopee) → "New Era" UNLESS card is KY Alliance
  * Facebook Ads → "New Era" UNLESS card is Carine CIMB or KY Alliance
  * Otherwise → null

Respond with ONLY a raw JSON array, no markdown code fences, no commentary, no leading/trailing text. Format:
[{"date":"15/06","description":"FACEBK *ADS8X7Y2Z","amount":450.00,"is_credit":false,"category":"${categorySlugs[0]}","channel":"SHARED","company_team":null}]

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

    // Sanity-clean each row — never trust external input blindly. Unknown/
    // invalid category slugs fall back to "other" if it exists, otherwise
    // the first category in the active list.
    const fallbackCategory = hasOther ? 'other' : categorySlugs[0];
    const cleaned = transactions
      .filter(t => t && typeof t.amount === 'number' && t.amount > 0 && t.description && !t.is_credit)
      .map(t => ({
        date: String(t.date || '').slice(0, 20),
        description: String(t.description || '').slice(0, 200),
        amount: Math.round(t.amount * 100) / 100,
        category: categorySlugs.includes(t.category) ? t.category : fallbackCategory,
        channel: CHANNELS.includes(t.channel) ? t.channel : 'SHARED',
        company_team: (t.company_team === 'New Era' || t.company_team === 'Alpha C') ? t.company_team : null
      }));

    const total = Math.round(cleaned.reduce((s,t) => s + t.amount, 0) * 100) / 100;

    return res.status(200).json({ success: true, transactions: cleaned, total, count: cleaned.length });
  } catch(e) {
    return res.status(500).json({ error: e.message });
  }
}
