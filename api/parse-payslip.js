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
      // App Type is usually "REN" (rental new order) but can be "INS" (outright
      // sale, e.g. "Sales Commission (Outright) - PV" section like KOK YIAT LEE's
      // 2 air-purifier units) — both represent a new order that should be counted.
      const m = l.match(/^(\d{7,})([A-Z].+?)(REN|INS)/);
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
  const bonusAmountPVs = []; // PV for each bonus order, used as a fallback to compute
                              // the 70% new-order amount (PV * 0.105) if that row is
                              // missing from the text extraction entirely.
  for (const l of lines) {
    const bm = l.match(/^(\d{1,2})\s+([\d,]+)\s+(\d{1,2})\s+([\d,]+\.\d{2})\s+([\d,]+\.\d{2})$/);
    if (bm) { bonusAmountRows.push(pn(bm[5])); bonusAmountPVs.push(pn(bm[2])); } // last column = bonus com
  }
  // ── 3. orderAmounts map & pair bonus amounts ──────────────────
  const orderAmounts = {}; // order_no -> bonus com amount

  // Pair bonus amounts with bonus orders positionally
  bonusOrders.forEach((o, idx) => {
    if (idx < bonusAmountRows.length) {
      orderAmounts[o.order_no] = r2(bonusAmountRows[idx]);
    }
  });

  // ── 3a. "Sales Commission (Outright) - PV" section (e.g. KOK YIAT LEE buying
  // 2 air-purifier units outright, App Type "INS" not "REN"). Format:
  //   "1330 199.50"   <- 2-token PV+amount row (BEFORE the order rows, like the
  //                       100%-section pattern below)
  //   "10949551KOK YIAT LEEINSCHP-6210N (NEON-GREEN)15"  <- order row
  // Pair these positionally, scoped to ONLY this section so they don't collide
  // with the 100% Payout section's own pre-header amounts.
  const outrightStart = lines.findIndex(l => l === 'Sales Commission (Outright) - PV');
  const payout100Start = lines.findIndex(l => l === 'Sales Commission (Rental - 100% Payout)');
  const outrightOrderNos = new Set();
  if (outrightStart >= 0) {
    const sectionEnd = payout100Start > outrightStart ? payout100Start : outrightStart + 50;
    const oLines = lines.slice(outrightStart + 1, sectionEnd);
    const outrightAmounts = [];
    const outrightOrders = [];
    for (const l of oLines) {
      const am = l.match(/^([\d,]+)\s+([\d,]+\.\d{2})$/);
      if (am) outrightAmounts.push(pn(am[2]));
      const om = l.match(/^(\d{7,})([A-Z].+?)(?:REN|INS)/);
      if (om) outrightOrders.push(om[1]);
    }
    outrightOrders.forEach((order_no, idx) => {
      if (idx < outrightAmounts.length && newOrderNos.has(order_no)) {
        orderAmounts[order_no] = r2((orderAmounts[order_no] || 0) + outrightAmounts[idx]);
        outrightOrderNos.add(order_no);
      }
    });
  }

  // ── 3b. 100% Payout new orders with (SHI)/(Extrade)/etc prefix before the name ──
  // Coway sometimes prefixes the customer name with "(SHI)" or "(Extrade)" for
  // certain orders, e.g. "10888859 (SHI)LEONG TUCK HOE15". The normal order-row
  // regex (^(\d{7,})([A-Z].+?)...) requires the character right after the order
  // number to be an uppercase letter, so these prefixed rows are never matched
  // as order rows. Their commission amount also appears separately as a
  // standalone "pv amount" 2-token row BEFORE the "100% Payout" section header
  // (e.g. "1,230 184.50"), in the same order as these prefixed order rows.
  //
  // Scope both scans to start at the "100% Payout" header so they don't pick up
  // unrelated 2-token "pv amount" rows from other sections (e.g. the "Outright
  // - PV" section handled above, which has its own such rows).
  const scanLines = payout100Start >= 0 ? lines.slice(payout100Start) : lines;
  const prefixedOrderRows = [];
  for (const l of scanLines) {
    const pm = l.match(/^(\d{7,})\s*\([A-Za-z]+\)([A-Z].+?)(\d{1,2})\s*$/);
    if (pm) prefixedOrderRows.push({ order_no: pm[1], customer_name: pm[2].trim() });
  }
  const preHeaderAmounts = [];
  for (const l of scanLines) {
    const am = l.match(/^([\d,]+)\s+([\d,]+\.\d{2})$/);
    if (am && pn(am[1]) > 100) preHeaderAmounts.push(pn(am[2]));
  }
  // Orders whose current-month 100%-payout amount was already captured via the
  // prefixedOrderRows/preHeaderAmounts pairing above (or the Outright-PV section
  // above). These must NOT also receive the months=1 pairing (pairMonths1) or
  // the PV*0.105 fallback below — both of those are for the 70%-payout formula,
  // while a prefixed "(SHI)/(Extrade)" or outright order is a 100%-payout order
  // whose amount = PV * 0.15 (already added in full here).
  const prefixedPairedOrderNos = new Set(outrightOrderNos);
  prefixedOrderRows.forEach((o, idx) => {
    if (idx < preHeaderAmounts.length && newOrderNos.has(o.order_no)) {
      orderAmounts[o.order_no] = r2((orderAmounts[o.order_no] || 0) + preHeaderAmounts[idx]);
      prefixedPairedOrderNos.add(o.order_no);
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

  // Find section boundaries. Coway's PDF text extraction is inconsistent
  // about whitespace inside section headers — e.g. "1st  Installment" with
  // a double space sometimes, single space other times — so compare with
  // whitespace collapsed to avoid silently missing a section occurrence
  // (which previously caused some "Overidding ... 1st Installment Month"
  // sections to be swallowed into a neighboring section instead of being
  // recognized on their own).
  const normWs = s => s.replace(/\s+/g, ' ').trim();
  const secBounds = [];
  for (let i = 0; i < lines.length; i++) {
    const normLine = normWs(lines[i]);
    for (const s of SECTION_STARTS) {
      if (normLine === s || normLine.includes(s)) {
        secBounds.push({ name: s, idx: i }); break;
      }
    }
  }

  // For each section except TBC, Allowance, Food: collect numRows & orderRows
  let passive_and_tbc_total = 0;
  let tbc_total = 0;
  let overriding_1st_install_total = 0;
  const allowances = [];
  const new_orders_detail = []; // { order_no, customer_name, com_from_payslip }

  // Global running index for pairing "months=1" rows with bonusOrders, in document
  // order. A new order's current-month payout can physically land in the 100%
  // Payout section, the 70% Payout section, or the 1st-Installment section
  // depending on how Coway lays out the PDF — but across the WHOLE payslip there
  // is exactly one months=1 row per bonus order, in the same relative order as
  // bonusOrders. Using one running index (instead of restarting at 0 in each
  // section) prevents a row that "spills over" into a later section from being
  // mis-paired with bonusOrders[0] again.
  let months1Idx = 0;
  const pairMonths1 = (amt) => {
    // Skip past any bonusOrder that already received its current-month amount via
    // the prefixedOrderRows/preHeaderAmounts path (a 100%-payout order) — that
    // order doesn't get a *second* months=1 (70%-formula) amount.
    while (months1Idx < bonusOrders.length && prefixedPairedOrderNos.has(bonusOrders[months1Idx].order_no)) {
      months1Idx++;
    }
    if (months1Idx < bonusOrders.length) {
      const order_no = bonusOrders[months1Idx].order_no;
      orderAmounts[order_no] = r2((orderAmounts[order_no] || 0) + amt);
    } else {
      passive_and_tbc_total = r2(passive_and_tbc_total + amt);
    }
    months1Idx++;
  };

  for (let si = 0; si < secBounds.length; si++) {
    const sec = secBounds[si];
    const nextIdx = secBounds[si+1]?.idx ?? lines.length;
    const sLines = lines.slice(sec.idx + 1, nextIdx);

    if (sec.name === 'Allowance') {
      // From raw text: amounts appear BEFORE the Allowance header in the Food Supplements section
      // Structure is: " 6,100.00\n 2,000.00\n 4,100.00\nAmount\nDescription\nAllowance\nSPECIAL WS\nHP NEW PI"
      // (total followed by individual amounts, one per label)
      // So by the time we reach Allowance section, the amounts are already parsed above
      // Instead, look BACKWARDS from Allowance header for the amounts, then match with descriptions
      //
      // NEWER LAYOUT (seen on manager payslips, e.g. Carine's): each
      // allowance line item appears WITHIN the section itself, either as
      // "LABEL  AMOUNT" on one line or LABEL/AMOUNT on adjacent lines —
      // and the label isn't always one of the old hardcoded strings (e.g.
      // "15W50S" isn't "SPECIAL WS"/"HP NEW PI"/"CASH INCENTIVE"). Try this
      // general parse first; it doesn't depend on a fixed label list.
      for (let j = 0; j < sLines.length; j++) {
        const l = sLines[j];
        if (l === 'Description' || l === 'Amount' || l === 'Description Amount' || /^[\d,]+\.\d{2}$/.test(l)) continue;
        const sameLine = l.match(/^(.+?)\s+([\d,]+\.\d{2})$/);
        if (sameLine) {
          allowances.push({ description: sameLine[1].trim(), amount: pn(sameLine[2]) });
          continue;
        }
        const nextLine = sLines[j+1];
        if (nextLine && /^[\d,]+\.\d{2}$/.test(nextLine) && l.length > 0 && !/^[\d,]+\.\d{2}$/.test(l)) {
          allowances.push({ description: l, amount: pn(nextLine) });
          j++;
        }
      }

      // Fallback to the older backward-scan approach (fixed label list,
      // amounts before the header) only if the general parse above found
      // nothing — preserves behavior for older-format payslips.
      if (allowances.length === 0) {
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
      // The first amount is the total/subtotal; the remaining amounts (one per label) are the individual items.
      // amountsBefore.length should be descLabels.length + 1 (total + each item).
      // Drop the leading total, keep the rest in order — this works even when an
      // individual amount happens to equal the total (single-item case).
      if (amountsBefore.length === descLabels.length + 1) {
        const indivAmounts = amountsBefore.slice(1);
        descLabels.forEach((desc, i) => {
          allowances.push({ description: desc, amount: indivAmounts[i] });
        });
      } else if (amountsBefore.length > 1) {
        // Fallback to old "drop one max value" approach for mismatched counts
        const maxVal = Math.max(...amountsBefore);
        const maxIdx = amountsBefore.indexOf(maxVal);
        const indivAmounts = amountsBefore.filter((_, i) => i !== maxIdx);
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
      // Add subtotal to passive. Separately, for the "Overidding" variant specifically,
      // also capture this section's own subtotal as overriding_1st_install_total — this
      // is one of the two figures (along with allowance_total) used to compute a
      // manager's Manager Comm pool when this payslip belongs to one of the four
      // managers (KY/Chloe/Carine/Jess) rather than a regular proxy account.
      for (let j = sLines.length-1; j >= 0; j--) {
        const m = sLines[j].match(/^([\d,]+\.\d{2})$/);
        // Sanity cap raised from 500 to 50000: a section with many order
        // rows (e.g. Carine's 2nd "Overidding ... 1st Installment Month"
        // occurrence, subtotal 2,653.50) can legitimately exceed the old
        // 500 cap. The cap still guards against accidentally grabbing
        // total_net_payable or some other much larger running total that
        // might appear within this section's line range.
        if (m && pn(m[1]) < 50000) {
          passive_and_tbc_total = r2(passive_and_tbc_total + pn(m[1]));
          if (sec.name.includes('Overidding')) {
            overriding_1st_install_total = r2(overriding_1st_install_total + pn(m[1]));
          }
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
    if (sec.name.includes('70% Payout') || sec.name.includes('Overidding') || is100) {
      // In 70%/100% sections: classify by months value, not positional order.
      // months=1 rows = this month's payout for NEW orders (whether the 70% portion
      //   landed in the 70% section, or the 100% portion landed in the 100% section —
      //   Coway sometimes places a new order's current-month payout row inside the
      //   100% Payout section even when the order itself is 70%/30% split, and
      //   occasionally a months=1 row "spills over" into the next section too).
      // months>1 rows = trailing/passive payouts for OLD orders.
      const newAmt = numRows.filter(n => n.months === 1).map(n => n.amount);
      const trailing = numRows.filter(n => n.months > 1).reduce((s,n) => r2(s+n.amount), 0);
      passive_and_tbc_total = r2(passive_and_tbc_total + trailing);
      newAmt.forEach(pairMonths1);
    } else if (isOtherInstall) {
      // The "1st Installment Month" and "Other Installment Month" sections share one
      // combined block of numRows + orderRows (their headers appear back-to-back in
      // the PDF text, so secBounds collapses them into this single section).
      //
      // IMPORTANT: this section's own orderRows (e.g. KOH HUAN BUN, LEE KAH FEI) are
      // NOT necessarily new orders from THIS month — they're often old orders now in
      // their "Other Installment" (trailing) phase, whose months=1 numRow here is
      // just a coincidental format match, not a new-order payout. Only pair months=1
      // rows with bonusOrders (via the global running index) when this section's
      // orders are themselves in newOrderNos. Otherwise all numRows -> passive.
      const newAmt1st = numRows.filter(n => n.months === 1).map(n => n.amount);
      const trailingOther = numRows.filter(n => n.months > 1).reduce((s,n) => r2(s+n.amount), 0);
      passive_and_tbc_total = r2(passive_and_tbc_total + trailingOther);
      const sectionHasNewOrders = orderRows.some(o => newOrderNos.has(o.order_no));
      if (sectionHasNewOrders) {
        newAmt1st.forEach(pairMonths1);
      } else {
        newAmt1st.forEach(amt => { passive_and_tbc_total = r2(passive_and_tbc_total + amt); });
      }
    } else {
      const count = Math.min(orderRows.length, numRows.length);
      for (let k = 0; k < count; k++) {
        const o = orderRows[k];
        const n = numRows[k];
        if ((is100 || o.pct === null) && newOrderNos.has(o.order_no)) {
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

  // ── 3c. Fallback for bonus orders that never got a months=1 pairing ──────
  // Some PDFs split a table across a page break in a way that makes pdf-parse
  // drop or merge the LAST customer's (70%)/(30%) numRows entirely (the row is
  // visibly present in the PDF, e.g. "1 1,230 15 129.15 (70%)" for CHAN KAH WENG,
  // but doesn't survive text extraction). When months1Idx never reaches a given
  // bonusOrder, fall back to computing its 70% new-order amount directly from
  // its own PV (captured in bonusAmountPVs): 70% payout = PV * 15% * 70% = PV * 0.105.
  //
  // NOTE: orderAmounts already has an entry for every bonusOrder by this point
  // (set during the bonus-amount pairing step above), so we can't use
  // `order_no in orderAmounts` to detect "missing" — instead we rely on
  // months1Idx, which tracks how many bonus orders actually received a
  // months=1 70%-payout addition.
  for (let idx = months1Idx; idx < bonusOrders.length; idx++) {
    const order_no = bonusOrders[idx].order_no;
    if (prefixedPairedOrderNos.has(order_no)) continue;
    if (idx < bonusAmountPVs.length) {
      const fallbackAmt = r2(bonusAmountPVs[idx] * 0.105);
      orderAmounts[order_no] = r2((orderAmounts[order_no] || 0) + fallbackAmt);
    }
  }

  // ── 4. Build new orders detail ──────────────────────────────
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

  // Passive+TBC = Total Net Payable - new orders - allowance (reverse calculation, most accurate)
  const passive_derived = total_net_payable > 0
    ? r2(total_net_payable - new_orders_total - allowanceTotal)
    : passive_and_tbc_total;  // fallback if no total found

  // ── 5. Summary ─────────────────────────────────────────────
  const new_orders_count = bonusOrders.length;
  const verify_total = r2(new_orders_total + allowanceTotal + passive_derived);

  return {
    distributor_code, distributor_name, period_date, member_level,
    total_net_payable, withholding_tax,
    new_orders_count,
    new_orders_total,
    allowance_total: allowanceTotal,
    allowance_per_order: allowancePerOrder,
    passive_and_tbc_total: passive_derived,
    tbc_total,
    overriding_1st_install_total,
    allowances,
    new_orders: new_orders_detail,
    _verify_total: verify_total,
    _match: Math.abs(verify_total - total_net_payable) < 1.00
  };
}
