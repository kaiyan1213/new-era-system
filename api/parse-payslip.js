export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const { base64, filename } = req.body;
  if (!base64) return res.status(400).json({ error: 'No PDF data provided' });

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) return res.status(500).json({ error: 'API key not configured' });

  try {
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
              text: `Extract from this Coway Commission Statement. Return ONLY valid JSON, no markdown.

RULES for orders in each category:
1. If months = 1 (first month / 70% payout): record in "new_orders" array with order_no, customer_name, months, pv, amount.
2. If months > 1 (trailing months / 30% payout / passive): do NOT list individually, just add amount to "trailing_total".
3. If months is not present in a section (like Sales Commission Rental 100% Payout): treat all as new_orders regardless of amount.
4. For Team Building Commission: only record the section total as "team_building_total", no individual rows.
5. Allowances (CASH INCENTIVE, HP NEW PI, SPECIAL WS, etc): record each description + amount.
6. Bonus Commission: treat all as new_orders (record order_no, customer_name, amount).

Return this exact structure:
{
  "distributor_code": "string",
  "distributor_name": "string",
  "period_date": "string",
  "member_level": "string",
  "total_net_payable": number,
  "withholding_tax": number,
  "categories": [
    {
      "name": "exact category name from PDF",
      "subtotal": number,
      "trailing_total": number,
      "new_orders": [
        { "order_no": "string", "customer_name": "string", "months": number, "pv": number, "amount": number }
      ]
    }
  ],
  "team_building_total": number,
  "allowances": [
    { "description": "string", "amount": number }
  ]
}

Verification: for each category, new_orders sum + trailing_total should equal subtotal.
Return ONLY the JSON object.`
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
    const parsed = JSON.parse(clean);
    return res.status(200).json({ success: true, data: parsed });

  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
}
