# Deploying

Two pieces, because they need different things:

| | Where | Why |
|---|---|---|
| **The dashboard** | Vercel | Reads committed data. No filesystem or long processes needed. |
| **Collection** | Local, or GitHub Actions | Needs a writable disk, minutes of runtime, and SearXNG on localhost. |

A serverless function has none of the second column. So the hosted app is a
**reader** of data collected elsewhere — plus the live AI-visibility probe,
which is plain HTTP and works anywhere.

---

## 1. Push to GitHub

```bash
npm run deploy:check          # catches secrets, missing data, bad entry points
git init
git add -A
git commit -m "Document360 competitive intelligence"
git remote add origin https://github.com/SuryaVenkataSubramanian/CompetitorIntelligence.git
git branch -M main
git push -u origin main
```

`deploy:check` is worth running first. It scans **every file git would
actually publish** for the literal value of each key in `.env`, so a secret
cannot reach a public repo by accident.

### The repo is private-by-default in spirit, not by default in fact

Nothing here is a credential, but `data/` contains competitive analysis of
named companies and the four allow-listed email addresses appear in
`collectors/lib/auth.js`. **Make the repository private.**

---

## 2. Environment variables in Vercel

Project → Settings → Environment Variables. These are the ones the hosted app
actually reads:

| Variable | Required | What breaks without it |
|---|---|---|
| `SESSION_SECRET` | **yes** | Nobody stays signed in. Generate: `npm run session:secret` |
| `AUTH_USERS_JSON` | **yes** | Every login is rejected. See below. |
| `DATAFORSEO_B64` | for AI Visibility | All six AI surfaces report *not checked* |
| `WINDSOR_API_KEY` | for referral traffic | The AI-referral panel reports unavailable |
| `DEPLOY_MODE` | no | Vercel is auto-detected; set `readonly` to force it |

`OCTOLENS_API_KEY`, `NEWSAPI_KEY` and `BRIGHTDATA_API_KEY` are only used by
collectors, which do not run on Vercel. Set them as **GitHub Actions secrets**
instead.

### Why `AUTH_USERS_JSON` exists

`collectors/store/auth-users.json` holds the scrypt hashes and is gitignored,
so a fresh deploy has no accounts. Provision locally, then paste the file's
contents into that variable:

```bash
npm run auth:init             # prints each password ONCE — save them
cat collectors/store/auth-users.json
```

It contains hashes and salts, never a password. Putting it in an environment
variable exposes no more than the file does.

### Sessions work differently when hosted — and this is a real trade-off

Locally, sessions are opaque tokens held in memory: **logout genuinely
revokes**. On Vercel every cold start is a new process, so an in-memory map
would sign everyone out at random intervals. There, tokens are HMAC-signed
cookies instead.

What that costs: `logout` clears the cookie but cannot invalidate a token
someone already copied. Two things bound it —

1. A 12-hour expiry, enforced inside the signature.
2. A **password fingerprint** in the token. Rotating a password
   (`npm run auth:init -- --reset`) changes it, so every token issued for the
   old password stops verifying immediately.

So revocation still works for the case that matters: killing a credential.

---

## 3. Deploy

Import the repo at [vercel.com/new](https://vercel.com/new). No build settings
to change — `vercel.json` handles routing, and there is nothing to compile.

**Framework preset: Other. Build command: leave empty.**

### One thing to know about the routing

`vercel.json` sends *every* path through the function, including CSS. That
looks like a missed optimisation and is deliberate: the app is deny-by-default,
so `index.html` and `app.js` require a session. Letting the CDN serve
`public/` directly would hand the dashboard to anyone with the URL. See
`VERCEL_NOTES.md`.

### Plan limits that will actually bite

- **`maxDuration` is 60s on Hobby.** A six-surface AI probe takes ~55s. The
  default selection (ChatGPT + Claude) is ~25-30s and fits comfortably.
  Selecting all six on Hobby may time out — a plan limit, not a bug. Pro
  allows 300s.
- **AI-probe history does not persist.** The measurement returns, but the
  filesystem is read-only, so it is not added to the stored history. The
  response says so via `history_persisted: false`. Metrics over time come from
  data collected locally and committed.

---

## 4. Keep the data fresh

`.github/workflows/collect.yml` runs daily at 06:00 UTC. It starts SearXNG as
a service container, runs the collectors, rebuilds `data/`, runs the accuracy
audit, and commits — which triggers a Vercel redeploy with the new data.

Add these as **repository secrets** (Settings → Secrets and variables →
Actions):

```
OCTOLENS_API_KEY    NEWSAPI_KEY      BRIGHTDATA_API_KEY
DATAFORSEO_B64      WINDSOR_API_KEY  DIGEST_TO
SMTP_HOST  SMTP_PORT  SMTP_USER  SMTP_PASS  SMTP_FROM   (optional)
```

The workflow **fails** if `audit-mentions.js` finds a structural accuracy
problem. That is intentional: bad data should not be committed and then served
to the team as fact.

### What is deliberately not automated

Sentiment classification and recommendation generation need an interactive
Claude Code session. They are the steps where a wrong answer would be a
*fabricated* one, so they stay manual — run `/refresh-intel` locally.

---

## 5. Sharing with the team

Send each person their email and the password from `auth:init`. Only the four
allow-listed addresses can authenticate; anyone else gets the same generic
error, so the login page leaks no information about who has access.

To add someone, edit `ALLOWED` in `collectors/lib/auth.js`, re-run
`npm run auth:init`, and update `AUTH_USERS_JSON` in Vercel.
