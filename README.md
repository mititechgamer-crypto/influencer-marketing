# Influencer Marketing App

Internal web app for managing influencer collaborations across **SimpleObjectz**, **Vaayuraksh**, and **Mintly Beverages**. Admin + multi-user with per-brand access, payment tracking, monthly/quarterly/yearly reports, full audit log, and login history.

---

## Run locally

```bash
npm install
npm start
```

Open http://localhost:3000. Default login: `admin` / `admin123` (change immediately on the **Account** page).

Local dev uses a SQLite file (`data.sqlite`) — zero setup.

---

## Deploy: Vercel (web) + Supabase (database)

Both have permanent free tiers that fit 3–4 daily users with room to spare. Vercel never spins down. Supabase only pauses after a full week of zero activity.

### 1. Push to a private GitHub repo

```bash
git init
git add .
git commit -m "Initial commit"

# Create a private repo and push (replace YOUR-USERNAME):
gh repo create influencer-marketing --private --source=. --push
# or do it via github.com → New repo → push manually
```

### 2. Create the Supabase database

1. Sign up at https://supabase.com (free, no card).
2. Click **New Project** → name it `influencer-marketing` → set a strong **database password** (save it).
3. Wait ~2 min for the project to provision.
4. Go to **Project Settings** → **Database** → **Connection string** → pick the **"Transaction"** pooler (port **6543**). Copy that URL.
   - **Important:** use the **Transaction pooler** (not Direct). Serverless platforms like Vercel need a connection pooler — direct connections will hit limits.
   - The URL looks like `postgres://postgres.xxxx:PASSWORD@aws-0-region.pooler.supabase.com:6543/postgres`.
   - Replace `[YOUR-PASSWORD]` placeholder with the password from step 2.

### 3. Deploy to Vercel

1. Sign up at https://vercel.com (free, GitHub login).
2. **Add New… → Project** → pick your `influencer-marketing` repo → **Import**.
3. Leave **Framework Preset** as "Other". Don't change build settings.
4. Expand **Environment Variables** and add:
   | Name | Value |
   |---|---|
   | `DATABASE_URL` | The Supabase pooler URL from step 2 |
   | `SESSION_SECRET` | Run `node -e "console.log(require('crypto').randomBytes(48).toString('hex'))"` locally and paste the output |
   | `INITIAL_ADMIN_PASSWORD` | Whatever you want the first admin password to be |
   | `NODE_ENV` | `production` |
5. Click **Deploy**. ~1 min later you'll get a URL like `https://influencer-marketing.vercel.app`.

### 4. First login

1. Visit your Vercel URL → log in as `admin` / *the password you set in `INITIAL_ADMIN_PASSWORD`*.
2. **Account** → change password (the env var was only used for first seed).
3. **Users** → create accounts for your team and check the brand(s) each can see.

---

## Features

**Roles**
- **Admin** — full CRUD across all brands; manages users.
- **User** — view-only, restricted to brand(s) the admin assigns.

**Per influencer:** handle, name, contact, email, product, script, deliverables, timeline (deliverable date), pay agreed (₹), advance paid (₹), payment status (unpaid/advance/full), review-submitted toggle (tracks whether they posted a review on the product page).

**Reports** — monthly / quarterly / yearly rollups with brand filter; totals for agreed/advance/paid/balance/reviews.

**Tracking (admin-only pages)**
- **Activity** (`/admin/activity`) — every add/edit/delete with who, what, when, and which fields changed. Filter by user or entity type. Paginated.
- **Logins** (`/admin/logins`) — every login attempt (success/fail), with username, timestamp, IP, and device user-agent. Filter by user.
- **Last updated by** — shown on every influencer detail page.

---

## Environment variables

| Variable | Required | Notes |
|---|---|---|
| `DATABASE_URL` | prod | Supabase **Transaction pooler** URL (port 6543). If unset, app uses SQLite (local dev). |
| `SESSION_SECRET` | prod | Long random string. Generate with `node -e "console.log(require('crypto').randomBytes(48).toString('hex'))"`. |
| `INITIAL_ADMIN_PASSWORD` | optional | Used **once** when seeding the first admin. Change on Account page after. |
| `NODE_ENV` | optional | Set to `production` on Vercel. |
| `PORT` | optional | Local default 3000. Vercel sets this automatically. |

See [`.env.example`](.env.example) for a template.

---

## Cost reality check

- **Vercel Hobby tier**: free. 100GB bandwidth/month, no spin-down. Your 3–4 users use ~kilobytes per page.
- **Supabase free tier**: free. 500MB Postgres, 2 free projects. Project pauses after **7 consecutive days of zero activity** — with daily logins this never triggers. If it ever does, click "Restore" in the dashboard and it's back in ~30s.
- **Expected monthly cost:** ₹0 indefinitely.

---

## File map

```
server.js          — Express app: routes, auth, audit, access checks
api/index.js       — Vercel serverless entrypoint
vercel.json        — Vercel rewrites + views/ includeFiles
lib/db.js          — DB adapter (Postgres if DATABASE_URL set, else SQLite)
lib/schema.js      — Schema, migrations, seed (runs on every boot, idempotent)
lib/audit.js       — Audit/login helpers
views/             — EJS templates (partials/header.ejs + partials/footer.ejs)
public/style.css   — UI styles
```

---

## Updating after deploy

Push to `main` → Vercel auto-redeploys.

Schema changes are baked into `lib/schema.js` — `CREATE TABLE IF NOT EXISTS` plus dialect-aware `ADD COLUMN` migrations run on every boot. New tables/columns deploy automatically. For destructive changes (rename / drop), write explicit migration SQL gated on `db.dialect`.

---

## Local development against the deployed DB

If you want to test the Postgres code path locally (rare — SQLite mode covers most cases):

```bash
DATABASE_URL="postgres://...supabase.../postgres" SESSION_SECRET=devsecret NODE_ENV=development npm start
```
