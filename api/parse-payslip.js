import { createRequire } from 'module';

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const { base64 } = req.body;
  if (!base64) return res.status(400).json({ error: 'No PDF data provided' });

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) return res.status(500).json({ error: 'API key not configured' });

  try {
    // Use Claude with a very strict structured extraction prompt
    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify({
        model: 'claude-sonnet-4-5',
        max_tokens: 4000,
        messages: [{
          role: 'user',
          content: [
            {
              type: 'document',
              source: { type: 'base64', media_type: 'application/pdf', data: base64 }
            },
            {
              type: 'text',
              text: `You are a precise data extractor for Coway Malaysia Commission Statements.

Extract the following and return ONLY a JSON object with no markdown:

STEP 1 - Header info:
- distributor_code: the number after "Distributor Code :"
- distributor_name: the name after "Distributor Name :"
- period_date: the value after "Date :"
- member_level: the value after "Member Level :"

STEP 2 - For each commission category section (e.g. "Sales Commission (Rental - 100% Payout)", "Sales Commission (Rental - 70% Payout)", "Bonus Commission", etc):
- name: exact section title
- subtotal: the standalone number that appears at the END of the section (before the next section title). This is the section total.
- For each order row in the section:
  - If the row has "Months" column and months > 1: it is a trailing payment, add to trailing_total only
  - If months = 1 OR there is no Months column: it is a new order, add to new_orders
  - new_orders fields: order_no, customer_name, months (null if no months column), pv, amount

STEP 3 - Team Building Commission:
- team_building_total: the total shown at the end of the TBC section (the large subtotal number)

STEP 4 - Allowances section (Description / Amount table near the end):
- Each row: description, amount

STEP 5 - Final totals from last page:
- total_net_payable: value after "TOTAL NET PAYABLE :"
- withholding_tax: absolute value after "Withholding Tax Deduction (2%) :"

IMPORTANT: subtotal for each category MUST equal sum of all new_orders amounts PLUS trailing_total. Double-check this before returning.

Return this structure:
{
  "distributor_code": "string",
  "distributor_name": "string", 
  "period_date": "string",
  "member_level": "string",
  "total_net_payable": number,
  "withholding_tax": number,
  "categories": [
    {
      "name": "string",
      "subtotal": number,
      "trailing_total": number,
      "new_orders": [
        {"order_no": "string", "customer_name": "string", "months": number|null, "pv": number, "amount": number}
      ]
    }
  ],
  "team_building_total": number,
  "allowances": [{"description": "string", "amount": number}]
}`
            }
          ]
        }]
      })
    });

    if (!response.ok) {
      const err = await response.text();
      return res.status(500).json({ error: `Anthropic API error: ${err}` });
    }

    const data = await response.json();
    const text = data.content?.find(c => c.type === 'text')?.text || '';
    const clean = text.replace(/```json|```/g, '').trim();

    let parsed;
    try {
      parsed = JSON.parse(clean);
    } catch(e) {
      return res.status(500).json({ error: 'JSON parse failed', raw: text.substring(0, 500) });
    }

    // Server-side validation: check subtotals add up
    for (const cat of (parsed.categories || [])) {
      const newSum = (cat.new_orders || []).reduce((s, o) => s + (o.amount || 0), 0);
      const trailing = cat.trailing_total || 0;
      const computed = Math.round((newSum + trailing) * 100) / 100;
      const reported = Math.round((cat.subtotal || 0) * 100) / 100;
      // Add computed sum to response for debugging
      cat._computed_sum = computed;
      cat._match = Math.abs(computed - reported) < 0.10;
    }

    return res.status(200).json({ success: true, data: parsed });

  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
}
