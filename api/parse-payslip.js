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

    if (debug) return res.status(200).json({ success: true, raw_text: text.substring(0, 10000) });

    const result = parseCowayPayslip(text);
    return res.status(200).json({ success: true, data: result });
  } catch(e) {
    return res.status(500).json({ error: e.message });
  }
}

function parseNum(s) { return parseFloat(String(s).replace(/,/g,'')) || 0; }

function parseCowayPayslip(text) {
  const lines = text.split('\n').map(l => l.trim()).filter(l => l.length > 0);

  // ── Header fields ─────────────────────────────────────────
  let distributor_code = null, distributor_name = null;
  let period_date = null, member_level = null;
  let total_net_payable = 0, withholding_tax = 0;

  for (let i = 0; i < lines.length; i++) {
    const l = lines[i];
    // Header: label on one line, value on next (or same line after colon)
    if (l === 'Distributor Code' && lines[i+1] === ':') distributor_code = lines[i+2];
    if (l === 'Distributor Name' && lines[i+1] === ':') distributor_name = lines[i+2];
    if (l === 'Date' && lines[i+1] === ':') period_date = lines[i+2];
    if (l === 'Member Level' && lines[i+1] === ':') member_level = lines[i+2];
    // Sometimes all on one line
    const codeM = l.match(/^(\d{5,8})$/);
    if (codeM && !distributor_code) distributor_code = codeM[1];
    const netM = l.match(/TOTAL NET PAYABLE\s*[:\s]\s*([\d,]+\.?\d*)/);
    if (netM) total_net_payable = parseNum(netM[1]);
    const whtM = l.match(/Withholding Tax Deduction.*?:\s*([\d,]+\.?\d*)/);
    if (whtM) withholding_tax = parseNum(whtM[1]);
  }

  // Distributor name: line right after the code number at top
  if (!distributor_name) {
    for (let i = 0; i < Math.min(lines.length, 30); i++) {
      if (lines[i].match(/^\d{5,8}$/) && lines[i+1]) {
        distributor_name = lines[i+1];
        break;
      }
    }
  }

  // ── Section boundaries ────────────────────────────────────
  const SECTIONS = [
    'Sales Commission (Rental - 100% Payout)',
    'Sales Commission (Rental - 70% Payout)',
    'Sales Overidding Commission ( HM Rental & 1st Installment Month)',
    'Sales Overidding Commission ( HM Rental & Other Installment Month)',
    'Sales Commission (Rental & 1st Installment Month)',
    'Sales Commission (Rental & Other Installment Month)',
    'Bonus Commission',
    'Food Supplements Sales Commission (100%)',
  ];
  const TBC = 'Team Building Commission';
  const ALLOWANCE = 'Allowance';

  // Find line indices where each section starts
  const sectionStarts = [];
  for (let i = 0; i < lines.length; i++) {
    for (const s of SECTIONS) {
      if (lines[i].includes(s)) { sectionStarts.push({ name: s, idx: i }); break; }
    }
  }
  // TBC
  let tbcIdx = -1;
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].includes(TBC)) { tbcIdx = i; break; }
  }
  // Allowance
  let allowIdx = -1;
  for (let i = 0; i < lines.length; i++) {
    if (lines[i] === ALLOWANCE) { allowIdx = i; break; }
  }

  // ── Parse each section ────────────────────────────────────
  const categories = [];

  for (let si = 0; si < sectionStarts.length; si++) {
    const { name, idx } = sectionStarts[si];
    // End of section = start of next section, TBC, allowance, or SHI Collection Rate
    const nextIdx = sectionStarts[si+1]?.idx ?? (tbcIdx > idx ? tbcIdx : lines.length);
    const endIdx = Math.min(
      nextIdx,
      tbcIdx > idx ? tbcIdx : lines.length,
      allowIdx > idx ? allowIdx : lines.length
    );

    const sectionLines = lines.slice(idx+1, endIdx);

    // In this section, we have two interleaved lists:
    // 1) Amount/numeric rows: " months pv amount" format -> e.g. " 9 1,600 6.54"  or " 1 1,230 129.15"
    // 2) Order rows: "ORDER_NO CUSTOMER_NAME  months  (pct%)" -> e.g. "10892675KAM YAU SIANG15 \n (70%)"
    //
    // PDF text dumps them in two columns. The number rows come first in sequence,
    // then the order+customer rows. We need to match them positionally.
    //
    // Number row pattern: optional spaces, integer(months), comma-number(pv), decimal(amount)
    const numRows = [];
    const orderRows = [];

    let j = 0;
    while (j < sectionLines.length) {
      const l = sectionLines[j];

      // Number row: "9 1,600 6.54" or "1 1,230 129.15" or " 1 900 135.00"
      const numM = l.match(/^(\d{1,2})\s+([\d,]+)\s+([\d,]+\.\d{2})$/);
      if (numM) {
        numRows.push({ months: parseInt(numM[1]), pv: parseNum(numM[2]), amount: parseNum(numM[3]) });
        j++; continue;
      }

      // Order row: starts with 7-8 digit order number, customer name, then months
      // Pattern: "10892675KAM YAU SIANG15" or "10892675 KAM YAU SIANG 15"
      const orderM = l.match(/^(\d{7,})\s*([A-Z].*?)(\d+)\s*$/);
      if (orderM) {
        const orderNo = orderM[1];
        const customer = orderM[2].trim();
        // Next line might be "(70%)" or "(30%)"
        let pct = null;
        if (j+1 < sectionLines.length) {
          const pctM = sectionLines[j+1].match(/^\(([\d]+)%\)$/);
          if (pctM) { pct = parseInt(pctM[1]); j++; }
        }
        orderRows.push({ order_no: orderNo, customer_name: customer, pct });
        j++; continue;
      }

      // Subtotal: standalone number at end of section
      const subM = l.match(/^([\d,]+\.\d{2})$/) ;
      if (subM && j === sectionLines.length - 1) {
        // This is the section subtotal, handled below
      }
      j++;
    }

    // Find subtotal (last standalone decimal number in section)
    let subtotal = 0;
    for (let k = sectionLines.length - 1; k >= 0; k--) {
      const subM = sectionLines[k].match(/^([\d,]+\.\d{2})$/);
      if (subM) { subtotal = parseNum(subM[1]); break; }
    }

    // Match numRows to orderRows positionally
    // In 100% payout sections (no months column in header), all are new orders
    const is100pct = name.includes('100%') || name.includes('1st Installment') || name.includes('Bonus');

    let new_orders = [];
    let trailing_total = 0;

    if (orderRows.length > 0 && numRows.length > 0) {
      // Match by position
      const count = Math.min(orderRows.length, numRows.length);
      for (let k = 0; k < count; k++) {
        const o = orderRows[k];
        const n = numRows[k];
        if (is100pct || o.pct === 70 || o.pct === null) {
          new_orders.push({ order_no: o.order_no, customer_name: o.customer_name, months: n.months, pv: n.pv, amount: n.amount });
        } else {
          trailing_total = Math.round((trailing_total + n.amount) * 100) / 100;
        }
      }
      // Extra numRows (old passive with no matching order row) = trailing
      if (numRows.length > orderRows.length) {
        for (let k = orderRows.length; k < numRows.length; k++) {
          trailing_total = Math.round((trailing_total + numRows[k].amount) * 100) / 100;
        }
      }
    } else if (numRows.length > 0) {
      // No order rows (e.g. some passive-only sections)
      trailing_total = numRows.reduce((s,n) => Math.round((s+n.amount)*100)/100, 0);
    }

    // Compute sum for validation
    const newSum = new_orders.reduce((s,o) => s+o.amount, 0);
    const computed = Math.round((newSum + trailing_total)*100)/100;

    categories.push({
      name, subtotal,
      trailing_total,
      new_orders,
      _computed_sum: computed,
      _match: subtotal === 0 || Math.abs(computed - subtotal) < 0.11
    });
  }

  // ── Team Building Commission ──────────────────────────────
  let team_building_total = 0;
  if (tbcIdx >= 0) {
    // TBC total = last standalone decimal before next major section
    const endSearch = allowIdx > tbcIdx ? allowIdx : lines.length;
    for (let i = endSearch - 1; i > tbcIdx; i--) {
      const m = lines[i].match(/^([\d,]+\.\d{2})$/);
      if (m) { team_building_total = parseNum(m[1]); break; }
    }
  }

  // ── Allowances ────────────────────────────────────────────
  const allowances = [];
  if (allowIdx >= 0) {
    // Look for Description Amount pairs until "Team Building" or "SHI Collection"
    for (let i = allowIdx + 1; i < lines.length; i++) {
      const l = lines[i];
      if (l.includes('Team Building') || l.includes('SHI Collection') || l.includes('Total Monetary')) break;
      // "DESCRIPTION  AMOUNT" or description line followed by amount line
      const inlineM = l.match(/^([A-Z][A-Z0-9\s\-_]+)\s+([\d,]+\.\d{2})$/);
      if (inlineM) { allowances.push({ description: inlineM[1].trim(), amount: parseNum(inlineM[2]) }); continue; }
      const descM = l.match(/^[A-Z][A-Z0-9\s\-_]{3,}$/) ;
      if (descM && i+1 < lines.length) {
        const nextM = lines[i+1].match(/^([\d,]+\.\d{2})$/);
        if (nextM) { allowances.push({ description: l, amount: parseNum(nextM[1]) }); i++; }
      }
    }
  }

  return { distributor_code, distributor_name, period_date, member_level,
    total_net_payable, withholding_tax, categories, team_building_total, allowances };
}
