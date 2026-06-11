import pdfParse from 'pdf-parse/lib/pdf-parse.js';

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const { base64 } = req.body;
  if (!base64) return res.status(400).json({ error: 'No PDF data' });

  try {
    const buffer = Buffer.from(base64, 'base64');
    const pdfData = await pdfParse(buffer);
    const text = pdfData.text;

    const result = parseCowayPayslip(text);
    return res.status(200).json({ success: true, data: result });
  } catch(e) {
    return res.status(500).json({ error: e.message });
  }
}

function parseCowayPayslip(text) {
  const lines = text.split('\n').map(l => l.trim()).filter(l => l.length > 0);

  // ── Header ──────────────────────────────────────────────
  const get = (label) => {
    for (const line of lines) {
      const m = line.match(new RegExp(label + '\\s*[:\\s]\\s*(.+)'));
      if (m) return m[1].trim();
    }
    return null;
  };

  const distributor_code = get('Distributor Code') || extractAfterColon(lines, 'Distributor Code');
  const distributor_name = get('Distributor Name') || extractAfterColon(lines, 'Distributor Name');
  const period_date      = get('Date') || extractAfterColon(lines, 'Date');
  const member_level     = get('Member Level') || extractAfterColon(lines, 'Member Level');

  // ── TOTAL NET PAYABLE ────────────────────────────────────
  let total_net_payable = 0;
  let withholding_tax   = 0;
  for (const line of lines) {
    let m = line.match(/TOTAL NET PAYABLE\s*[:\s]\s*([\d,]+\.?\d*)/);
    if (m) total_net_payable = parseNum(m[1]);
    m = line.match(/Withholding Tax Deduction.*?:\s*([\d,]+\.?\d*)/);
    if (m) withholding_tax = parseNum(m[1]);
  }

  // ── Category sections ────────────────────────────────────
  const CATEGORY_HEADERS = [
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

  const categories = [];
  let team_building_total = 0;
  const allowances = [];

  let i = 0;
  while (i < lines.length) {
    const line = lines[i];

    // ── Team Building Commission ──
    if (line.includes(TBC_HEADER)) {
      // TBC total is a standalone number that appears after all TBC rows
      // Scan forward until we find a standalone number followed by a non-numeric section
      let tbcTotal = 0;
      let j = i + 1;
      while (j < lines.length) {
        const tl = lines[j];
        // Stop at next major section
        if (CATEGORY_HEADERS.some(h => tl.includes(h)) || tl.includes('SHI Collection') || tl.includes('Total Monetary')) break;
        // Standalone total line: just a number
        const standaloneNum = tl.match(/^([\d,]+\.\d{2})$/);
        if (standaloneNum) tbcTotal = parseNum(standaloneNum[1]);
        j++;
      }
      team_building_total = tbcTotal;
      i = j;
      continue;
    }

    // ── Allowance section ──
    if (line === ALLOWANCE_HEADER || line.startsWith('Allowance')) {
      let j = i + 1;
      while (j < lines.length) {
        const al = lines[j];
        if (al.includes('Team Building') || al.includes('SHI Collection') || al.includes('Total Monetary')) break;
        // Match "DESCRIPTION  AMOUNT" pattern — amount is standalone number after description
        // Lines like: "CASH INCENTIVE" followed by amount, or "CASH INCENTIVE 1200.00"
        const inlineMatch = al.match(/^([A-Z][A-Z\s]+[A-Z])\s+([\d,]+\.\d{2})$/);
        if (inlineMatch) {
          allowances.push({ description: inlineMatch[1].trim(), amount: parseNum(inlineMatch[2]) });
          j++;
          continue;
        }
        // Description on one line, amount on next
        const isDesc = al.match(/^[A-Z][A-Z\s]{3,}$/) && !al.match(/^\d/);
        if (isDesc && j + 1 < lines.length) {
          const nextNum = lines[j+1].match(/^([\d,]+\.\d{2})$/);
          if (nextNum) {
            allowances.push({ description: al, amount: parseNum(nextNum[1]) });
            j += 2;
            continue;
          }
        }
        j++;
      }
      i = j;
      continue;
    }

    // ── Commission categories ──
    const matchedHeader = CATEGORY_HEADERS.find(h => line.includes(h));
    if (matchedHeader) {
      const cat = { name: matchedHeader, subtotal: 0, trailing_total: 0, new_orders: [] };

      let j = i + 1;
      // Skip header rows (SHI line, column headers)
      while (j < lines.length && (lines[j].match(/^Individual Customer/) || lines[j].match(/^Order No/) || lines[j].match(/SHI\s*:/))) j++;

      while (j < lines.length) {
        const cl = lines[j];

        // Stop conditions
        if (CATEGORY_HEADERS.some(h => cl.includes(h)) || cl.includes(TBC_HEADER) || cl.includes(ALLOWANCE_HEADER) || cl.includes('SHI Collection Rate') || cl.includes('Total Monetary') || cl.includes('TOTAL NET PAYABLE')) break;

        // Standalone subtotal: a number alone on a line that follows order rows
        const standalone = cl.match(/^([\d,]+\.\d{2})$/);
        if (standalone) {
          cat.subtotal = parseNum(standalone[1]);
          j++;
          break;
        }

        // Order row detection
        // Format varies: order_no customer_name [app_type] [months] pv % amount
        // Order numbers are 8+ digits
        const orderMatch = cl.match(/^(\d{7,})\s+(.+)/);
        if (orderMatch) {
          const orderNo = orderMatch[1];
          const rest = orderMatch[2];
          // Extract amount (last number in line)
          const nums = rest.match(/([\d,]+\.\d{2})/g);
          if (nums && nums.length > 0) {
            const amount = parseNum(nums[nums.length - 1]);
            // Extract months: look for a small integer (1-30) that appears before PV
            // PV values are typically 600-5000, months are 1-30
            const allNums = rest.match(/\b(\d+)\b/g) || [];
            let months = null;
            let pv = null;
            // Find months: small number 1-30
            for (const n of allNums) {
              const v = parseInt(n);
              if (v >= 1 && v <= 30 && months === null) { months = v; continue; }
              if (v > 100 && pv === null) { pv = v; break; }
            }
            // Customer name: everything before first number sequence
            const customerMatch = rest.match(/^([A-Za-z\s\.\(\)\/&]+?)(?=\s+(?:REN|NEW|\d))/);
            const customer_name = customerMatch ? customerMatch[1].trim() : rest.split(/\s{2,}/)[0].trim();

            if (months === 1 || months === null) {
              cat.new_orders.push({ order_no: orderNo, customer_name, months, pv, amount });
            } else {
              cat.trailing_total = Math.round((cat.trailing_total + amount) * 100) / 100;
            }
          }
        }
        j++;
      }

      // If subtotal wasn't found as standalone, compute it
      if (cat.subtotal === 0) {
        const newSum = cat.new_orders.reduce((s, o) => s + o.amount, 0);
        cat.subtotal = Math.round((newSum + cat.trailing_total) * 100) / 100;
      }

      // Validation
      const computedSum = Math.round((cat.new_orders.reduce((s,o)=>s+o.amount,0) + cat.trailing_total)*100)/100;
      cat._computed_sum = computedSum;
      cat._match = Math.abs(computedSum - cat.subtotal) < 0.11;

      categories.push(cat);
      i = j;
      continue;
    }

    i++;
  }

  return {
    distributor_code,
    distributor_name,
    period_date,
    member_level,
    total_net_payable,
    withholding_tax,
    categories,
    team_building_total,
    allowances
  };
}

function extractAfterColon(lines, label) {
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].includes(label) && lines[i].includes(':')) {
      const parts = lines[i].split(':');
      if (parts[1]) return parts[1].trim();
    }
    if (lines[i].includes(label) && i + 1 < lines.length) {
      return lines[i+1].trim();
    }
  }
  return null;
}

function parseNum(str) {
  if (!str) return 0;
  return parseFloat(String(str).replace(/,/g, '')) || 0;
}
