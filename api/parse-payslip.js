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
    // Total Net Payable - try multiple formats
    const nm = l.match(/TOTAL NET PAYABLE\s*[:\s]\s*([\d,]+\.?\d*)/);
    if (nm) total_net_payable = pn(nm[1]);
    const wm = l.match(/Withholding Tax Deduction.*?:\s*([\d,]+\.?\d*)/);
    if (wm) withholding_tax = pn(wm[1]);
  }
  // Also try finding "TOTAL NET PAYABLE :" on one line, number on next
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].includes('TOTAL NET PAYABLE') && total_net_payable === 0) {
      // Try next few lines for the number
      for (let j = i; j < Math.min(i+3, lines.length); j++) {
        const m = lines[j].match(/([\d,]+\.\d{2})/);
        if (m && pn(m[1]) > 100) { total_net_payable = pn(m[1]); break; }
      }
    }
    if (lines[i].includes('Withholding Tax Deduction') && withholding_tax === 0) {
      for (let j = i; j < Math.min(i+3, lines.length); j++) {
        const m = lines[j].match(/([\d,]+\.\d{2})/);
        if (m) { withholding_tax = pn(m[1]); break; }
      }
    }
  }

  // ── 2. Find Bonus Commission section & extract new order numbers ──
  const bonusStart = lines.findIndex(l => l === 'Bonus Commission');
  const newOrderNos = new Set();
  const bonusOrders = [];

  if (bonusStart >= 0) {
    const bonusEnd = lines.findIndex((l, i) => i > bonusStart &&
      (l === 'Food Supplements Sales Commission (100%)' || l.includes('Team Building') || l === 'Allowance'));
    const bLines = lines.slice(bonusStart + 1, bonusEnd > 0 ? bonusEnd : bonusStart + 100);
    for (const l of bLines) {
      const m = l.match(/^(\d{7,})([A-Z].+?)REN/);
      if (m) {
        newOrderNos.add(m[1]);
        bonusOrders.push({ order_no: m[1], customer_name: m[2].trim() });
      }
    }
  }

  // ── 2b. Extract bonus amounts globally (they appear BEFORE "Bonus Commission" header) ──
  // Format: "1 pv bonus_pct amount amount" e.g. "1 1,230 9 110.70 110.70"
  // These appear right before "AmountBONUS%PVMonthStock DescType" line
  const bonusAmountRows = [];
  for (const l of lines) {
    const bm = l.match(/^(\d{1,2})\s+([\d,]+)\s+(\d{1,2})\s+([\d,]+\.\d{2})\s+([\d,]+\.\d{2})$/);
    if (bm) bonusAmountRows.push(pn(bm[5])); // last column = bonus com
  }
  // ── 3. orderAmounts map & pair bonus amounts ──────────────────
  const orderAmounts = {}; // order_no -> bonus com amount

  // Pair bonus amounts with bonus orders positionally
  bonusOrders.forEach((o, idx) => {
    if (idx < bonusAmountRows.length) {
      orderAmounts[o.order_no] = r2(bonusAmountRows[idx]);
    }
  });

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
      // From raw text: amounts appear BEFORE the Allowance header in the Food Supplements section
      // Structure is: " 6,100.00\n 2,000.00\n 4,100.00\nAmount\nDescription\nAllowance\nSPECIAL WS\nHP NEW PI"
      // So by the time we reach Allowance section, the amounts are already parsed above
      // Instead, look BACKWARDS from Allowance header for the amounts, then match with descriptions
      const descLabels = [];
      for (const l of sLines) {
        if (l === 'SPECIAL WS' || l === 'HP NEW PI' || l === 'CASH INCENTIVE') descLabels.push(l);
      }
      // Find amounts just before Allowance header in the full lines array
      const allowHeaderIdx = sec.idx;
      const amountsBefore = [];
      for (let k = allowHeaderIdx - 1; k >= Math.max(0, allowHeaderIdx - 15); k--) {
        const m = lines[k].match(/^\s*([\d,]+\.\d{2})\s*$/);
        if (m) amountsBefore.unshift(pn(m[1]));
        else if (lines[k].includes('Food Supplements') || lines[k].includes('Order No')) break;
      }
      // Remove total (largest) and keep individual amounts
      if (amountsBefore.length > 1) {
        const maxVal = Math.max(...amountsBefore);
        const indivAmounts = amountsBefore.filter(n => n !== maxVal);
        descLabels.forEach((desc, i) => {
          if (i < indivAmounts.length) allowances.push({ description: desc, amount: indivAmounts[i] });
        });
      } else if (amountsBefore.length === 1 && descLabels.length === 1) {
        allowances.push({ description: descLabels[0], amount: amountsBefore[0] });
      }
      // Fallback: if no amounts found before, check after
      if (allowances.length === 0) {
        for (let j = 0; j < sLines.length; j++) {
          const l = sLines[j];
          if (l === 'SPECIAL WS' || l === 'HP NEW PI' || l === 'CASH INCENTIVE') {
            const nm = sLines[j+1]?.match(/^([\d,]+\.\d{2})$/);
            if (nm) { allowances.push({ description: l, amount: pn(nm[1]) }); j++; }
          }
        }
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
      // Bonus amounts already extracted globally and paired above
      // Just skip this section in the loop
      continue;
    }

    if (sec.name === 'Sales Commission (Rental & 1st Installment Month)' ||
        sec.name === 'Sales Overidding Commission ( HM Rental & 1st Installment Month)') {
      // 1st Install section - contains: subtotal, regular "1 pv amount" rows, and order rows
      // Regular rows (month=1, no bonus_pct) go to passive (already counted in 70% section)
      // Just add subtotal to passive
      for (let j = sLines.length-1; j >= 0; j--) {
        const m = sLines[j].match(/^([\d,]+\.\d{2})$/);
        if (m && pn(m[1]) < 500) { // subtotal should be modest
          passive_and_tbc_total = r2(passive_and_tbc_total + pn(m[1]));
          break;
        }
      }
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
    if (sec.name.includes('70% Payout') || sec.name.includes('Overidding')) {
      // In 70% section: classify by months value, not positional order
      // months=1 rows = new orders (70% payout), months>1 = trailing (30%)
      const newAmt70 = numRows.filter(n => n.months === 1).map(n => n.amount);
      const trailing70 = numRows.filter(n => n.months > 1).reduce((s,n) => r2(s+n.amount), 0);
      passive_and_tbc_total = r2(passive_and_tbc_total + trailing70);
      // Assign new order amounts to bonus orders by position
      // Both are in same sequence (new orders appear at end of 70% section)
      newAmt70.forEach((amt, idx) => {
        if (idx < bonusOrders.length) {
          orderAmounts[bonusOrders[idx].order_no] = r2((orderAmounts[bonusOrders[idx].order_no] || 0) + amt);
        } else {
          passive_and_tbc_total = r2(passive_and_tbc_total + amt);
        }
      });
    } else {
      const count = Math.min(orderRows.length, numRows.length);
      for (let k = 0; k < count; k++) {
        const o = orderRows[k];
        const n = numRows[k];
        if (isOtherInstall) {
          passive_and_tbc_total = r2(passive_and_tbc_total + n.amount);
        } else if ((is100 || o.pct === null) && newOrderNos.has(o.order_no)) {
          orderAmounts[o.order_no] = r2((orderAmounts[o.order_no] || 0) + n.amount);
        } else {
          passive_and_tbc_total = r2(passive_and_tbc_total + n.amount);
        }
      }
      if (numRows.length > orderRows.length) {
        for (let k = orderRows.length; k < numRows.length; k++) {
          passive_and_tbc_total = r2(passive_and_tbc_total + numRows[k].amount);
        }
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
