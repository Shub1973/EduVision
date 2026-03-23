# EduVision Live — Vercel Deployment Guide

Real-time educational image recognition using Claude Vision + YouTube.
The Anthropic API key lives **only on the server** — never in the browser.

---

## Project Structure

```
eduvision/
├── api/
│   └── analyze.js        ← Serverless function (holds your API key securely)
├── public/
│   └── index.html        ← Frontend (no API key needed)
├── vercel.json           ← Routing config
├── package.json
└── .gitignore
```

---

## Deploy to Vercel (5 minutes)

### Step 1 — Install Vercel CLI
```bash
npm install -g vercel
```

### Step 2 — Deploy
```bash
cd eduvision
vercel
```
Follow the prompts:
- Set up and deploy? **Y**
- Which scope? *(your account)*
- Link to existing project? **N**
- Project name: **eduvision** *(or anything)*
- In which directory is your code? **./** *(press Enter)*

### Step 3 — Set your API key (THE KEY STEP)
In the Vercel dashboard → Your Project → Settings → Environment Variables:

| Name                  | Value              | Environment        |
|-----------------------|--------------------|--------------------|
| `ANTHROPIC_API_KEY`   | `sk-ant-...`       | Production, Preview |

Or via CLI:
```bash
vercel env add ANTHROPIC_API_KEY
```

### Step 4 — Redeploy with the env var
```bash
vercel --prod
```

Your app is now live at `https://eduvision.vercel.app` (or your custom domain).

---

## Rate Limiting

Default: **20 requests per IP per minute** (set in `api/analyze.js`).

To change it, edit these two constants at the top of `api/analyze.js`:
```js
const RATE_LIMIT = 20;    // max requests
const WINDOW_MS  = 60_000; // per 1 minute
```

### Upgrade to persistent rate limiting (recommended for production)

Vercel's in-memory rate limiter resets on each cold start (each serverless
function spin-up). For truly persistent limits across all instances, use
Vercel KV (free tier available):

```bash
vercel kv create eduvision-ratelimit
npm install @vercel/kv
```

Then in `api/analyze.js`, replace the `isRateLimited` function with the
KV version shown in the comments at the bottom of that file.

---

## Adding User Accounts (optional next step)

If you want per-user logins to track usage or personalise the experience,
the easiest drop-in option for Vercel is **Clerk** (free tier):

1. Sign up at clerk.com → create an application
2. `npm install @clerk/clerk-js`
3. Add `NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY` to Vercel env vars
4. Wrap your HTML with Clerk's JS SDK for sign-in/sign-up UI

Clerk handles Google, GitHub, email/password login out of the box and
works with Vercel serverless functions.

---

## Local Development

```bash
cd eduvision
npm install
# create a local env file
echo "ANTHROPIC_API_KEY=sk-ant-YOUR_KEY_HERE" > .env.local
# run locally with Vercel dev (emulates serverless functions)
npx vercel dev
```

Open `http://localhost:3000` — camera + full API works locally.

---

## Security Checklist

- [x] API key stored in Vercel environment variables only
- [x] Key never sent to or stored in the browser
- [x] Image size limit enforced (2 MB max)
- [x] IP-based rate limiting on the serverless function
- [ ] (Optional) Tighten CORS in `api/analyze.js` to your domain only
- [ ] (Optional) Add Vercel KV for persistent rate limiting
- [ ] (Optional) Add user auth with Clerk
