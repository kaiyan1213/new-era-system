// parse-cc-statement.js v2026-07-09
// v2026-06-26-password-support
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

  const { base64, debug, categories, cardName, pdfPassword } = req.body;
  const cardNameUpper = (cardName || '').toUpperCase();
  const isKYAlliance = cardNameUpper.includes('KY') || cardNameUpper.includes('JENNY');
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
    // Try pdf-parse first; if text extraction is poor (< 500 chars of useful content),
    // fall back to sending the PDF directly as a document to Claude (vision mode)
    let text = '';
    try {
      const pdfOptions = pdfPassword ? { password: pdfPassword } : {};
      const pdfData = await pdfParse(buffer, pdfOptions);
      text = pdfData.text || '';
    } catch(e) { text = ''; }
    if (debug) return res.status(200).json({ success: true, raw_text: text.substring(0, 12000) });

    const trimmedText = text.length > 18000 ? text.slice(0, 18000) : text;
    // Check if text extraction looks useful (has amounts/dates)
    const hasUsefulText = /\d{2}\/\d{2}\/\d{2}/.test(text) && /\d+\.\d{2}/.test(text) && text.length > 500;

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
- card_last4: CRITICAL — some banks (e.g. CIMB) mail out ONE combined PDF covering MULTIPLE distinct physical cards under the same cardholder, each printed as its own section with its own masked card number (e.g. "5521-1527-0319-9529" or "XXXX-XXXX-XXXX-9529") and its own "PREVIOUS BALANCE ... STATEMENT BALANCE" block. If the statement has more than one such card-number section, set card_last4 to the last 4 digits of whichever card-number section this specific transaction physically appears under (e.g. "9529"). If the statement only ever shows ONE card number throughout, set card_last4 to that card's last 4 digits (or null if no card number is printed anywhere).

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
  * This statement is from card: "${cardName || 'unknown'}" — isKYAlliance: ${isKYAlliance}
  * If isKYAlliance is true → gift (Shopee) = "Alpha C", ads (Facebook) = "Alpha C", Manychat = "Alpha C"
  * If isKYAlliance is false → gift = "New Era", ads = "New Era", Manychat = "New Era"
  * AI tools (ANTHROPIC, OPENAI, APPLE, PADDLE) → always null (shared, split 50/50)
  * Otherwise → null

IMPORTANT: Extract ALL charge/purchase transactions from ALL sections of the statement (including sections labeled "VISA INFINITE", "TAN KAI YAN", or any cardholder name). Do NOT skip any section — but DO keep each section's transactions tagged with the correct card_last4 (see above) so they can be told apart. NEVER merge two different cards' amounts into one number anywhere in your response — each card section has its OWN previous balance and statement balance printed directly above/below its own transaction list; a page-level "Cards Summary" table near the top listing multiple "Credit Card No." rows is a strong signal this statement covers more than one card.

Respond with ONLY a raw JSON object (no markdown, no code fences), with these keys:
1. "transactions": array of ALL charge transactions found (each tagged with card_last4 per the rule above).
   EXCLUDE ONLY these specific types:
   - Lines with "CR" suffix (refunds/credits)
   - Lines starting with "PAYMENT RECEIVED", "DUITNOW TO", "TRANSFER FROM", "TOP-UP THANK YOU"
   - "PREVIOUS BALANCE", "MINIMUM PAYMENT", "CURRENT BALANCE", "STATEMENT BALANCE" summary lines
   ALWAYS INCLUDE (even if they look like fees or subscriptions):
   - "CREDIT PROTECTOR" or any insurance/protection fee
   - "Ezypay" or any instalment/subscription payment
   - "APPLE.COM/BILL" or any Apple subscription
   - "OPENAI" or any AI subscription
   - "MANYCHAT" or any SaaS subscription
   - Interest charges, service tax, annual fees
   - Any merchant purchase/charge that does NOT have "CR" after the amount
   - is_credit must be TRUE only if the amount has "CR" suffix, or is explicitly a DUITNOW TO / PAYMENT RECEIVED line
   - NEVER set is_credit: true just because the description contains words like "BILL", "SUBSCRIPTION", "SERVICE"
2. "cr_amounts": array of numeric amounts (MYR) that appeared with "CR" suffix (refunds/credits/payments)
3. "cards": array with ONE entry per distinct card number section found in the statement — this is the SOURCE OF TRUTH for balances, never a hand-summed total. Each entry: {"card_last4": "9529", "statement_balance": 13435.64, "previous_balance": 24421.39}. If the statement only covers one card, this array still has exactly one entry (card_last4 can be null if no card number is printed). Read each card's own statement_balance/previous_balance directly from that card's own section — do NOT add multiple cards' balances together anywhere.
4. "statement_balance": DEPRECATED but still required for backward compatibility — set this to the SUM of every entry's statement_balance in "cards" (so old clients still see a combined total), never a number you invent separately.
5. "previous_balance": DEPRECATED but still required — set this to the SUM of every entry's previous_balance in "cards".

Format (single-card example):
{"transactions":[{"date":"15/06","description":"FACEBK *ADS8X7Y2Z","amount":450.00,"is_credit":false,"category":"${categorySlugs[0]}","channel":"SHARED","company_team":null,"card_last4":null}],"cr_amounts":[56.45,3.15],"cards":[{"card_last4":null,"statement_balance":44543.40,"previous_balance":30361.46}],"statement_balance":44543.40,"previous_balance":30361.46}

Format (multi-card example — two cards under one PDF, balances kept separate):
{"transactions":[{"date":"15/07","description":"FACEBK *4RHZ6WMRF2","amount":539.56,"is_credit":false,"category":"${categorySlugs[0]}","channel":"DM","company_team":null,"card_last4":"9529"},{"date":"17/07","description":"FACEBK *TF5UTUZV72","amount":2928.83,"is_credit":false,"category":"${categorySlugs[0]}","channel":"DM","company_team":null,"card_last4":"7293"}],"cr_amounts":[],"cards":[{"card_last4":"9529","statement_balance":13435.64,"previous_balance":24421.39},{"card_last4":"7293","statement_balance":2953.83,"previous_balance":0}],"statement_balance":16389.47,"previous_balance":24421.39}

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
        max_tokens: 16000,
        messages: [{ role: 'user', content: pdfPassword && text.length > 200
          // If password-protected, pdf-parse decrypted it — use text mode
          ? prompt.replace('Statement text:', 'Statement text (decrypted):')
          // Otherwise send PDF directly for best accuracy
          : [
            {
              type: 'document',
              source: { type: 'base64', media_type: 'application/pdf', data: base64 }
            },
            { type: 'text', text: prompt.split('Statement text:')[0] + 'The PDF statement is attached above. Extract all transactions from it.' }
          ]
        }]
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
    // If Claude prepended text before the JSON, extract the JSON object/array
    const jsonObjMatch = raw.match(/\{[\s\S]*\}/);
    const jsonArrMatch = raw.match(/\[[\s\S]*\]/);
    if (jsonObjMatch && (!jsonArrMatch || jsonObjMatch.index <= jsonArrMatch.index)) {
      raw = jsonObjMatch[0];
    } else if (jsonArrMatch) {
      raw = jsonArrMatch[0];
    }

    let transactions;
    let claudeCrAmounts = [];
    let claudeStatementBalance = null;
    let claudePreviousBalance = null;
    let claudeCards = [];
    try {
      const parsed = JSON.parse(raw);
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed) && Array.isArray(parsed.transactions)) {
        transactions = parsed.transactions;
        claudeCrAmounts = Array.isArray(parsed.cr_amounts) ? parsed.cr_amounts.map(Number).filter(n => !isNaN(n)) : [];
        claudeStatementBalance = (typeof parsed.statement_balance === 'number') ? parsed.statement_balance : null;
        claudePreviousBalance = (typeof parsed.previous_balance === 'number') ? parsed.previous_balance : null;
        // "cards" is the source of truth for per-card balances (added so
        // combined multi-card statements, e.g. CIMB mailing one PDF for
        // two physical cards, never get their balances silently summed
        // into a single card's tracker entry). Older prompt responses
        // (or a model that ignores the new instruction) won't have this
        // key — fall back to a single synthetic entry built from the
        // legacy top-level fields so single-card statements keep working
        // exactly as before.
        if (Array.isArray(parsed.cards) && parsed.cards.length > 0) {
          claudeCards = parsed.cards
            .filter(c => c && typeof c.statement_balance === 'number')
            .map(c => ({
              card_last4: (typeof c.card_last4 === 'string' && c.card_last4.trim()) ? c.card_last4.trim().slice(-4) : null,
              statement_balance: c.statement_balance,
              previous_balance: (typeof c.previous_balance === 'number') ? c.previous_balance : null
            }));
        }
        if (claudeCards.length === 0 && claudeStatementBalance !== null) {
          claudeCards = [{ card_last4: null, statement_balance: claudeStatementBalance, previous_balance: claudePreviousBalance }];
        }
      } else if (Array.isArray(parsed)) {
        transactions = parsed; // old format fallback
      } else {
        return res.status(502).json({ error: 'Claude did not return expected JSON. Raw: ' + raw.slice(0, 500) });
      }
    } catch(parseErr) {
      return res.status(502).json({ error: 'Could not parse Claude response as JSON. Raw: ' + raw.slice(0, 500) });
    }

    if (!Array.isArray(transactions)) {
      return res.status(502).json({ error: 'Claude did not return a JSON array.' });
    }

    // Build a set of amounts that appear as "CR" (credit/refund) in the raw PDF text.
    // This is a regex-based safety net — Claude sometimes returns CR transactions as
    // normal entries, so we cross-check against the raw text to catch them.
    // Note: pdf-parse may put the amount and "CR" on separate lines, so we check both
    // inline ("56.45 CR") and next-line ("56.45\nCR") patterns.
    const crAmountSet = new Set();
    // Match "amount CR" on same line
    const crRegexInline = /([\d,]+\.\d{2})\s*CR\b/gi;
    let crMatch;
    while ((crMatch = crRegexInline.exec(text)) !== null) {
      const amt = parseFloat(crMatch[1].replace(/,/g, ''));
      if (!isNaN(amt)) crAmountSet.add(Math.round(amt * 100));
    }
    // Match amount on one line, CR alone on the next line
    const lines = text.split(/\r?\n/);
    for (let i = 0; i < lines.length - 1; i++) {
      const cur = lines[i].trim();
      const next = lines[i + 1].trim();
      if (/^CR$/i.test(next)) {
        const amtMatch = cur.match(/([\d,]+\.\d{2})$/);
        if (amtMatch) {
          const amt = parseFloat(amtMatch[1].replace(/,/g, ''));
          if (!isNaN(amt)) crAmountSet.add(Math.round(amt * 100));
        }
      }
      // Also handle "56.45 CR" as the entire line content
      const lineMatch = cur.match(/^([\d,]+\.\d{2})\s+CR$/i);
      if (lineMatch) {
        const amt = parseFloat(lineMatch[1].replace(/,/g, ''));
        if (!isNaN(amt)) crAmountSet.add(Math.round(amt * 100));
      }
    }

    // Sanity-clean each row — never trust external input blindly. Unknown/
    // invalid category slugs fall back to "other" if it exists, otherwise
    // the first category in the active list.
    const fallbackCategory = hasOther ? 'other' : categorySlugs[0];
    // Build a count map so each CR cancels only ONE charge of same amount
    const crCountMap = {};
    crAmountSet.forEach(cents => { crCountMap[cents] = (crCountMap[cents] || 0) + 1; });
    const cleaned = transactions
      .filter(t => {
        if (!t || typeof t.amount !== 'number' || t.amount <= 0 || !t.description) return false;
        const amtCents = Math.round(t.amount * 100);
        // If Claude flagged is_credit AND there is a matching CR, count it as cancelled
        if (t.is_credit) {
          if (crCountMap[amtCents] > 0) crCountMap[amtCents]--;
          return false;
        }
        // Cross-check: each CR cancels ONE matching charge (not all)
        if (crCountMap[amtCents] > 0) { crCountMap[amtCents]--; return false; }
        return true;
      })
      .map(t => ({
        date: String(t.date || '').slice(0, 20),
        description: String(t.description || '').slice(0, 200),
        amount: Math.round(t.amount * 100) / 100,
        category: categorySlugs.includes(t.category) ? t.category : fallbackCategory,
        channel: CHANNELS.includes(t.channel) ? t.channel : 'SHARED',
        company_team: (t.company_team === 'New Era' || t.company_team === 'Alpha C') ? t.company_team : null,
        // Which physical card (last 4 digits) this transaction belongs to
        // — null when the statement only ever shows one card, or the
        // card number couldn't be found. See "cards" below for the
        // authoritative per-card balances.
        card_last4: (typeof t.card_last4 === 'string' && t.card_last4.trim()) ? t.card_last4.trim().slice(-4) : null
      }));

    const total = Math.round(cleaned.reduce((s,t) => s + t.amount, 0) * 100) / 100;
    // Merge Claude's cr_amounts with regex-detected ones
    claudeCrAmounts.forEach(a => crAmountSet.add(Math.round(a * 100)));
    const crAmounts = [...crAmountSet].map(c => c/100);

    // Distinct card sections actually detected — more than one means this
    // single PDF covers multiple physical cards (e.g. a CIMB combined
    // statement) and the frontend must review/save each one separately
    // instead of lumping their statement balances together.
    const isMultiCard = claudeCards.length > 1;

    console.log('[Parser] cleaned count:', cleaned.length, 'raw transactions count:', transactions.length, 'cr_amounts:', claudeCrAmounts, 'stmt_bal:', claudeStatementBalance, 'cards:', claudeCards.length, 'isMultiCard:', isMultiCard);
    return res.status(200).json({
      success: true,
      transactions: cleaned,
      total,
      count: cleaned.length,
      _cr_filtered: crAmounts,
      // Legacy singular fields — kept for backward compatibility with any
      // caller that only reads these. For a multi-card statement these
      // are the SUM across all cards (never use them to save a single
      // card's tracker entry once is_multi_card is true).
      statement_balance: claudeStatementBalance,
      previous_balance: claudePreviousBalance,
      // Per-card breakdown — the source of truth. Always at least one
      // entry when parsing succeeded.
      cards: claudeCards,
      is_multi_card: isMultiCard,
      _debug_raw_count: transactions.length
    });
  } catch(e) {
    return res.status(500).json({ error: e.message });
  }
}
