# New Era Consulting Enterprise — Internal System

Internal management system for New Era Consulting Enterprise (202503018811).

## Modules
- **Proxy Invoice Manager** — Track proxy accounts, generate monthly invoices
- **Staff Payroll** — Sales commission + Admin fixed salary
- **Manager Profit Sharing** — 4 co-founders Coway payslip distribution
- **P&L Dashboard** — Revenue vs costs by channel (DM / TM / XHS / Other)
- **Tax Export** — Full-year CSV export per proxy & company P&L

## Tech Stack
- Vanilla JS + HTML (single file)
- Supabase (PostgreSQL backend)
- Vercel (hosting)

## First-time Setup
1. Go to `/` → Setup tab
2. Run the SQL in Supabase SQL Editor
3. Initialize the 4 managers with their % share
4. Run Connection Test to verify

## Deployment
Hosted on Vercel. Push to `main` branch to auto-deploy.
