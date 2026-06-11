import pdfParse from 'pdf-parse/lib/pdf-parse.js';

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
  const { base64, debug } = req.body;
  if (!base64) return res.status(400).json({ error: 'No PDF data' });
  try {
    const buffer = Buffer.from(base64, 'base64');
    const pdfData = await pdfParse(buffer);
    const text = pdfData.text;
    if (debug) return res.status(200).json({ success: true, raw_text: text.substring(0, 12000) });
    const result = parseCowayPayslip(text);
    return res.status(200).json({ success: true, data: result });
  } catch(e) {
    return res.status(500).json({ error: e.message });
  }
}

function parseNum(s) { return parseFloat(String(s).replace(/,/g,'')) || 0; }

function parseCowayPayslip(text) {
  const lines = text.split('\n').map(l => l.trim()).filter(l => l.length > 0);

  // ── Header ─────────────────────────────────────────────────
  let distributor_code = null, distributor_name = null;
  let period_date = null, member_level = null;
  let total_net_payable = 0, withholding_tax = 0;

  // First 5-8 digit number = distributor code, next non-empty line = name
  for (let i = 0; i < Math.min(lines.length, 15); i++) {
    if (!distributor_code && lines[i].match(/^\d{5,8}$/)) {
      distributor_code = lines[i];
      if (lines[i+1] && !lines[i+1].match(/^\d/) && lines[i+1].length > 3) {
        distributor_name = lines[i+1];
      }
    }
  }
  // Date and member level from structured header
  for (let i = 0; i < lines.length; i++) {
    if (lines[i] === 'Date' && lines[i+1] === ':') period_date = lines[i+2];
    if (lines[i] === 'Member Level' && lines[i+1] === ':') member_level = lines[i+2];
    const netM = lines[i].match(/TOTAL NET PAYABLE\s*[:\s]\s*([\d,]+\.?\d*)/);
    if (netM) total_net_payable = parseNum(netM[1]);
    const whtM = lines[i].match(/Withholding Tax Deduction.*?:\s*([\d,]+\.?\d*)/);
    if (whtM) withholding_tax = parseNum(whtM[1]);
  }

  // ── Strategy: find each section by its header, then find its subtotal ────
  // The subtotal appears as a standalone decimal number just before the next section header
  // New orders are identified by (70%) marker, trailing by (30%) marker
  // Num rows (months pv amount) are paired with order rows in sequence within each page block

  const SECTION_HEADERS = [
    'Sales Commission (Rental - 100% Payout)',
    'Sales Commission (Rental - 70% Payout)',
    'Sales Overidding Commission ( HM Rental & 1st Installment Month)',
    'Sales Overidding Commission ( HM Rental & Other Installment Month)',
    'Sales Commission (Rental & 1st Installment Month)',
    'Sales Commission (Rental & Other Installment Month)',
    'Bonus Commission',
    'Food Supplements Sales Commission (100%)',
  ];
  const TBC_HEADER = 'Team Building Commission';
  const ALLOWANCE_HEADER = 'Allowance';
  const STOP_WORDS = ['SHI Collection Rate', 'Total Monetary', 'TOTAL NET PAYABLE', 'Withholding Tax'];

  // Find all section start indices
  const allSections = [];
  for (let i = 0; i < lines.length; i++) {
    for (const h of SECTION_HEADERS) {
      if (lines[i] === h || lines[i].includes(h)) {
        allSections.push({ name: h, idx: i }); break;
      }
    }
    if (lines[i].includes(TBC_HEADER)) allSections.push({ name: TBC_HEADER, idx: i });
    if (lines[i] === ALLOWANCE_HEADER) allSections.push({ name: ALLOWANCE_HEADER, idx: i });
  }

  const categories = [];
  let team_building_total = 0;
  const allowances = [];

  for (let si = 0; si < allSections.length; si++) {
    const sec = allSections[si];
    const nextIdx = allSections[si+1]?.idx ?? lines.length;

    // Slice lines for this section
    const sLines = lines.slice(sec.idx + 1, nextIdx);

    if (sec.name === ALLOWANCE_HEADER) {
      // Parse allowances: description + standalone amount pairs
      for (let j = 0; j < sLines.length; j++) {
        const l = sLines[j];
        if (STOP_WORDS.some(w => l.includes(w))) break;
        // "SPECIAL WS" then "2,000.00" on next line
        if (l.match(/^[A-Z][A-Z0-9\s\-_\/]{2,}$/) && !l.match(/^\d/)) {
          const nextNum = sLines[j+1]?.match(/^([\d,]+\.\d{2})$/);
          if (nextNum) { allowances.push({ description: l, amount: parseNum(nextNum[1]) }); j++; continue; }
          // Or inline: "SPECIAL WS 2,000.00"
          const inlineM = l.match(/^(.+?)\s+([\d,]+\.\d{2})$/);
          if (inlineM) { allowances.push({ description: inlineM[1].trim(), amount: parseNum(inlineM[2]) }); continue; }
        }
        // Standalone number after previous description
        const numM = l.match(/^([\d,]+\.\d{2})$/);
        if (numM && j > 0 && !sLines[j-1].match(/^\d/)) {
          // already handled above
        }
      }
      continue;
    }

    if (sec.name === TBC_HEADER) {
      // TBC total = the standalone decimal that appears at the very end of the TBC block
      // It's the LAST standalone decimal before the next section
      let lastNum = 0;
      for (const l of sLines) {
        if (STOP_WORDS.some(w => l.includes(w))) break;
        const m = l.match(/^([\d,]+\.\d{2})$/);
        if (m) lastNum = parseNum(m[1]);
      }
      team_building_total = lastNum;
      continue;
    }

    // ── Commission category ───────────────────────────────────
    // Find subtotal: the standalone decimal that appears as the section total
    // It's the FIRST standalone decimal after the order rows, right before next section
    // But there may be page numbers (single digit or "2","3" etc) in between
    // Strategy: find all standalone decimals in section, the LAST one before next header = subtotal
    let subtotal = 0;
    for (let j = sLines.length - 1; j >= 0; j--) {
      const m = sLines[j].match(/^([\d,]+\.\d{2})$/);
      if (m) { subtotal = parseNum(m[1]); break; }
    }

    const is100pct = sec.name.includes('100%');
    const isBonus = sec.name.includes('Bonus');
    const is1stInstall = sec.name.includes('1st Installment');
    const isOtherInstall = sec.name.includes('Other Installment');

    // Collect num rows: "months pv amount" pattern
    // Note: months 1-30, pv 600-9999, amount decimal
    // Also Bonus has: "1 pv bonus_pct bonus_pct amount" - 5 numbers
    const numRows = [];
    const orderRows = [];

    for (let j = 0; j < sLines.length; j++) {
      const l = sLines[j];

      // Skip page numbers, column headers, REN lines, SHI lines
      if (l.match(/^\d$/) || l.match(/^\d{1,2}$/) && parseNum(l) < 100) continue;
      if (l === 'REN' || l === 'NEW' || l.includes('Customer Name') || l.includes('Order No')
        || l.includes('App Type') || l.includes('Individual Customer')
        || l.includes('Commission Statement') || l.match(/^[A-Z]+%[A-Z]+/)) continue;

      // Num row: "months pv amount" - 3 tokens where months<=30, pv>100, amount is decimal
      const numM3 = l.match(/^(\d{1,2})\s+([\d,]+)\s+([\d,]+\.\d{2})$/);
      if (numM3) {
        const months = parseInt(numM3[1]);
        const pv = parseNum(numM3[2]);
        const amount = parseNum(numM3[3]);
        if (months >= 1 && months <= 30 && pv > 100) {
          numRows.push({ months, pv, amount }); continue;
        }
      }

      // Bonus num row: "1 pv bonus_pct bonus_pct amount" -> "1 1,230 9 110.70 110.70"
      const bonusM = l.match(/^(\d{1,2})\s+([\d,]+)\s+(\d+)\s+([\d,]+\.\d{2})\s+([\d,]+\.\d{2})$/);
      if (bonusM) {
        numRows.push({ months: parseInt(bonusM[1]), pv: parseNum(bonusM[2]), amount: parseNum(bonusM[5]) }); continue;
      }

      // Order row: 7-8 digit number + customer name + 15 (or other months)
      // Pattern like: "10892675KAM YAU SIANG15"
      const orderM = l.match(/^(\d{7,})([A-Z].+?)(\d{1,2})\s*$/);
      if (orderM) {
        const orderNo = orderM[1];
        const customer = orderM[2].trim();
        let pct = null;
        // Next line: (70%) or (30%)
        if (j+1 < sLines.length) {
          const pctM = sLines[j+1].match(/^\((\d+)%\)$/);
          if (pctM) { pct = parseInt(pctM[1]); j++; }
        }
        orderRows.push({ order_no: orderNo, customer_name: customer, pct });
        continue;
      }

      // For sections without pct marker (1st install, other install, bonus with no pct)
      const orderM2 = l.match(/^(\d{7,})([A-Z].+?)(\d{1,2})$/);
      if (orderM2 && !l.includes('REN')) {
        const pctM = sLines[j+1]?.match(/^\((\d+)%\)$/);
        if (!pctM) {
          orderRows.push({ order_no: orderM2[1], customer_name: orderM2[2].trim(), pct: null });
        }
      }
    }

    // Match num rows to order rows positionally
    let new_orders = [];
    let trailing_total = 0;

    if (orderRows.length > 0) {
      const count = Math.min(orderRows.length, numRows.length);
      for (let k = 0; k < count; k++) {
        const o = orderRows[k];
        const n = numRows[k];
        // 100%, 1st install, bonus: all new orders (no trailing)
        if (is100pct || isBonus || is1stInstall || o.pct === 70 || o.pct === null) {
          new_orders.push({ order_no: o.order_no, customer_name: o.customer_name, months: n.months, pv: n.pv, amount: n.amount });
        } else {
          // (30%) = trailing
          trailing_total = Math.round((trailing_total + n.amount) * 100) / 100;
        }
      }
      // Extra numRows with no matching order = old passive (no order number)
      if (numRows.length > orderRows.length) {
        for (let k = orderRows.length; k < numRows.length; k++) {
          trailing_total = Math.round((trailing_total + numRows[k].amount) * 100) / 100;
        }
      }
    } else if (numRows.length > 0) {
      // No order rows found - all nums are trailing passive
      if (is100pct || isBonus) {
        // Shouldn't happen but treat as new
        new_orders = numRows.map(n => ({ order_no: null, customer_name: null, months: n.months, pv: n.pv, amount: n.amount }));
      } else {
        trailing_total = numRows.reduce((s,n) => Math.round((s+n.amount)*100)/100, 0);
      }
    }

    // Other Installment: these rows don't have (70%)/(30%) markers — all are trailing
    if (isOtherInstall) {
      trailing_total = numRows.reduce((s,n) => Math.round((s+n.amount)*100)/100, 0);
      new_orders = [];
    }

    const computed = Math.round((new_orders.reduce((s,o)=>s+o.amount,0) + trailing_total)*100)/100;

    categories.push({
      name: sec.name, subtotal, trailing_total, new_orders,
      _computed_sum: computed,
      _match: subtotal === 0 || Math.abs(computed - subtotal) < 0.11
    });
  }

  // ── Food Supplements / Allowance special handling ─────────
  // Food Supplements section often has no order rows, just a subtotal
  // The subtotal may be split: "6,100.00" then "2,000.00" then "4,100.00" = total is 6100
  // Allowances: SPECIAL WS + HP NEW PI appear in Allowance section
  // Let's re-parse allowances more carefully
  const allowanceIdx = allSections.find(s => s.name === ALLOWANCE_HEADER);
  if (allowanceIdx && allowances.length === 0) {
    const aLines = lines.slice(allowanceIdx.idx + 1);
    for (let j = 0; j < aLines.length; j++) {
      const l = aLines[j];
      if (STOP_WORDS.some(w => l.includes(w)) || l.includes('Team Building')) break;
      if (l === 'SPECIAL WS' || l === 'HP NEW PI' || l === 'CASH INCENTIVE' || l === 'HP NEW PI') {
        const nextM = aLines[j+1]?.match(/^([\d,]+\.\d{2})$/);
        if (nextM) { allowances.push({ description: l, amount: parseNum(nextM[1]) }); j++; }
      }
    }
  }

  return { distributor_code, distributor_name, period_date, member_level,
    total_net_payable, withholding_tax, categories, team_building_total, allowances };
}
