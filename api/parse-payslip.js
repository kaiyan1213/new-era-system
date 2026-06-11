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

function pn(s) { return parseFloat(String(s).replace(/,/g,'')) || 0; }
function r2(n) { return Math.round(n * 100) / 100; }

function parseCowayPayslip(text) {
  const lines = text.split('\n').map(l => l.trim()).filter(l => l.length > 0);

  // ── 1. Header ──────────────────────────────────────────────
  let distributor_code = null, distributor_name = null;
  let period_date = null, member_level = null;
  let total_net_payable = 0, withholding_tax = 0;

  for (let i = 0; i < Math.min(lines.length, 20); i++) {
    if (!distributor_code && lines[i].match(/^\d{5,8}$/)) {
      distributor_code = lines[i];
      if (lines[i+1] && lines[i+1].match(/^[A-Z]/) && lines[i+1].length > 3)
        distributor_name = lines[i+1];
    }
    if (lines[i] === 'Date' && lines[i+1] === ':') period_date = lines[i+2];
    if (lines[i] === 'Member Level' && lines[i+1] === ':') member_level = lines[i+2];
  }
  for (const l of lines) {
    const nm = l.match(/TOTAL NET PAYABLE\s*[:\s]\s*([\d,]+\.?\d*)/);
    if (nm) total_net_payable = pn(nm[1]);
    const wm = l.match(/Withholding Tax Deduction.*?:\s*([\d,]+\.?\d*)/);
    if (wm) withholding_tax = pn(wm[1]);
  }

  // ── 2. Find Bonus Commission section & extract new order numbers ──
  // Bonus section format: order_no + customer + REN + product_desc (all on one line or split)
  // e.g. "10892675KAM YAU SIANGRENCHP-6210N (NEON-PINK)"
  const bonusStart = lines.findIndex(l => l === 'Bonus Commission');
  const newOrderNos = new Set();
  const bonusOrders = []; // { order_no, customer_name }

  if (bonusStart >= 0) {
    // Find end of bonus section
    const bonusEnd = lines.findIndex((l, i) => i > bonusStart &&
      (l === 'Food Supplements Sales Commission (100%)' || l.includes('Team Building') || l === 'Allowance'));

    const bLines = lines.slice(bonusStart + 1, bonusEnd > 0 ? bonusEnd : bonusStart + 100);
    for (const l of bLines) {
      // Pattern: "10892675KAM YAU SIANGRENCHP-6210N..."
      const m = l.match(/^(\d{7,})([A-Z].+?)REN/);
      if (m) {
        const orderNo = m[1];
        const customer = m[2].trim();
        newOrderNos.add(orderNo);
        bonusOrders.push({ order_no: orderNo, customer_name: customer });
      }
    }
  }

  // ── 3. Collect ALL amount rows from entire payslip ──────────
  // Map: order_no -> total amount across all sections
  // Num row formats:
  //   "months pv amount"  e.g. "1 1,230 129.15"
  //   "months pv bonus% bonus amount"  e.g. "1 1,230 9 110.70 110.70"
  // Order row: "ORDER_NOCustomerName15 \n (70%) or (30%)"
  // We need to pair them positionally within each section

  // Strategy: scan through ALL lines, collect (order_no, amount) pairs
  // For sections with (70%)/(30%) markers, pair order rows with preceding num rows
  // For bonus section, pair order rows with following num rows

  const orderAmounts = {}; // order_no -> total amount

  // Parse 70% section specifically - it has the bulk of data
  // The PDF structure: num rows appear BEFORE their order rows within each page block
  // We'll do a global scan: collect all num rows and all order rows, pair by position

  // Actually the most reliable: for each order_no found anywhere, sum up all
  // "months pv amount" rows that correspond to it.
  // But since they're positional, we need section-by-section parsing.

  // Let's do a cleaner approach:
  // Within 70% section, pairs are: numRow[i] <-> orderRow[i]
  // The num rows and order rows are interleaved in page chunks

  const SECTION_STARTS = [
    'Sales Commission (Rental - 100% Payout)',
    'Sales Commission (Rental - 70% Payout)',
    'Sales Overidding Commission ( HM Rental & 1st Installment Month)',
    'Sales Overidding Commission ( HM Rental & Other Installment Month)',
    'Sales Commission (Rental & 1st Installment Month)',
    'Sales Commission (Rental & Other Installment Month)',
    'Bonus Commission',
    'Food Supplements Sales Commission (100%)',
    'Team Building Commission',
    'Allowance',
  ];

  // Find section boundaries
  const secBounds = [];
  for (let i = 0; i < lines.length; i++) {
    for (const s of SECTION_STARTS) {
      if (lines[i] === s || lines[i].includes(s)) {
        secBounds.push({ name: s, idx: i }); break;
      }
    }
  }

  // For each section except TBC, Allowance, Food: collect numRows & orderRows
  let passive_and_tbc_total = 0;
  let tbc_total = 0;
  const allowances = [];
  const new_orders_detail = []; // { order_no, customer_name, com_from_payslip }

  for (let si = 0; si < secBounds.length; si++) {
    const sec = secBounds[si];
    const nextIdx = secBounds[si+1]?.idx ?? lines.length;
    const sLines = lines.slice(sec.idx + 1, nextIdx);

    if (sec.name === 'Allowance') {
      // Parse SPECIAL WS, HP NEW PI, CASH INCENTIVE
      for (let j = 0; j < sLines.length; j++) {
        const l = sLines[j];
        if (l === 'SPECIAL WS' || l === 'HP NEW PI' || l === 'CASH INCENTIVE') {
          const nm = sLines[j+1]?.match(/^([\d,]+\.\d{2})$/);
          if (nm) { allowances.push({ description: l, amount: pn(nm[1]) }); j++; }
        }
        // Also inline format
        const inm = l.match(/^(SPECIAL WS|HP NEW PI|CASH INCENTIVE)\s+([\d,]+\.\d{2})$/);
        if (inm) allowances.push({ description: inm[1], amount: pn(inm[2]) });
      }
      continue;
    }

    if (sec.name === 'Team Building Commission') {
      // TBC total = last standalone decimal in section
      for (let j = sLines.length - 1; j >= 0; j--) {
        const m = sLines[j].match(/^([\d,]+\.\d{2})$/);
        if (m) { tbc_total = pn(m[1]); break; }
      }
      continue;
    }

    if (sec.name === 'Food Supplements Sales Commission (100%)') {
      // Food supplements: find the first standalone large decimal = subtotal
      for (const l of sLines) {
        const m = l.match(/^([\d,]+\.\d{2})$/);
        if (m && pn(m[1]) > 10) {
          // This is the food supplements total, treat as passive
          passive_and_tbc_total = r2(passive_and_tbc_total + pn(m[1]));
          break;
        }
      }
      continue;
    }

    if (sec.name === 'Bonus Commission') {
      // Bonus: num rows have format "1 pv bonus% bonus amount"
      // pair with bonus order rows (already collected above)
      const bonusNumRows = [];
      for (const l of sLines) {
        // "1 1,230 9 110.70 110.70" - last number is amount
        const bm = l.match(/^(\d{1,2})\s+([\d,]+)\s+(\d+)\s+([\d,]+\.\d{2})\s+([\d,]+\.\d{2})$/);
        if (bm) bonusNumRows.push(pn(bm[5])); // last amount
        // Also "months pv amount" regular format
        const nm = l.match(/^(\d{1,2})\s+([\d,]+)\s+([\d,]+\.\d{2})$/);
        if (nm && parseInt(nm[1]) <= 30) bonusNumRows.push(pn(nm[3]));
      }
      // Pair with bonusOrders
      bonusOrders.forEach((o, idx) => {
        if (idx < bonusNumRows.length) {
          orderAmounts[o.order_no] = r2((orderAmounts[o.order_no] || 0) + bonusNumRows[idx]);
        }
      });
      continue;
    }

    // ── 100% / 70% / Install sections ──
    const is100 = sec.name.includes('100%');
    const isOtherInstall = sec.name.includes('Other Installment');

    // Collect num rows and order rows
    const numRows = [];
    const orderRows = [];

    for (let j = 0; j < sLines.length; j++) {
      const l = sLines[j];
      // Skip noise
      if (l.match(/^[12]?\d$/) && pn(l) < 50) continue; // page numbers
      if (['REN','NEW','Customer Name','Order No','App Type','Months','AMOUNT','AMT','Amount'].includes(l)) continue;
      if (l.includes('Individual Customer') || l.includes('Commission Statement')) continue;
      if (l.includes('%PV') || l.includes('App Type')) continue;

      // Num row: "months pv amount"
      const nm = l.match(/^(\d{1,2})\s+([\d,]+)\s+([\d,]+\.\d{2})$/);
      if (nm && parseInt(nm[1]) >= 1 && parseInt(nm[1]) <= 30 && pn(nm[2]) > 100) {
        numRows.push({ months: parseInt(nm[1]), pv: pn(nm[2]), amount: pn(nm[3]) });
        continue;
      }

      // Order row: 7+ digit order no + customer + 15 (contract months)
      const om = l.match(/^(\d{7,})([A-Z].+?)(\d{1,2})\s*$/);
      if (om) {
        let pct = null;
        if (j+1 < sLines.length) {
          const pm = sLines[j+1].match(/^\((\d+)%\)$/);
          if (pm) { pct = parseInt(pm[1]); j++; }
        }
        orderRows.push({ order_no: om[1], customer_name: om[2].trim(), pct });
      }
    }

    // Find section subtotal
    let subtotal = 0;
    for (let j = sLines.length-1; j >= 0; j--) {
      const m = sLines[j].match(/^([\d,]+\.\d{2})$/);
      if (m) { subtotal = pn(m[1]); break; }
    }

    // Pair and accumulate
    const count = Math.min(orderRows.length, numRows.length);
    for (let k = 0; k < count; k++) {
      const o = orderRows[k];
      const n = numRows[k];
      if (isOtherInstall) {
        // All trailing
        passive_and_tbc_total = r2(passive_and_tbc_total + n.amount);
      } else if (is100 || o.pct === 70 || o.pct === null) {
        // New order - accumulate into orderAmounts
        orderAmounts[o.order_no] = r2((orderAmounts[o.order_no] || 0) + n.amount);
      } else {
        // (30%) trailing
        passive_and_tbc_total = r2(passive_and_tbc_total + n.amount);
      }
    }
    // Extra numRows (no matching order) = old passive
    if (numRows.length > orderRows.length) {
      for (let k = orderRows.length; k < numRows.length; k++) {
        passive_and_tbc_total = r2(passive_and_tbc_total + numRows[k].amount);
      }
    }
  }

  // ── 4. Build new orders detail ──────────────────────────────
  // Allowance per order
  const allowanceTotal = r2(allowances.reduce((s,a) => s + a.amount, 0));
  const allowancePerOrder = bonusOrders.length > 0 ? r2(allowanceTotal / bonusOrders.length) : 0;

  let new_orders_total = 0;
  for (const o of bonusOrders) {
    const comFromPayslip = r2(orderAmounts[o.order_no] || 0);
    const totalCom = r2(comFromPayslip + allowancePerOrder);
    new_orders_detail.push({
      order_no: o.order_no,
      customer_name: o.customer_name,
      com_from_payslip: comFromPayslip,
      allowance_portion: allowancePerOrder,
      total_com: totalCom
    });
    new_orders_total = r2(new_orders_total + comFromPayslip);
  }

  // Add TBC to passive bucket
  passive_and_tbc_total = r2(passive_and_tbc_total + tbc_total);

  // ── 5. Summary ─────────────────────────────────────────────
  const new_orders_count = bonusOrders.length;
  const verify_total = r2(new_orders_total + allowanceTotal + passive_and_tbc_total);

  return {
    distributor_code, distributor_name, period_date, member_level,
    total_net_payable, withholding_tax,
    new_orders_count,
    new_orders_total,        // com from new orders (excl allowance)
    allowance_total: allowanceTotal,
    allowance_per_order: allowancePerOrder,
    passive_and_tbc_total,   // trailing + TBC + food supplements
    tbc_total,
    allowances,
    new_orders: new_orders_detail,
    _verify_total: verify_total,
    _match: Math.abs(verify_total - total_net_payable) < 1.00
  };
}
