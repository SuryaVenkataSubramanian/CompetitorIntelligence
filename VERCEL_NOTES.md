# Why vercel.json looks like this

## Framework Preset: **Other**

There is no framework to detect — zero npm dependencies, no `next.config.*`,
no `vite.config.*`, nothing to compile. The whole app is one Node request
handler.

| Vercel field | Value |
|---|---|
| Framework Preset | **Other** |
| Root Directory | `./` |
| Build Command | leave empty *(see note on `vercel-build` below)* |
| Output Directory | leave empty |
| Install Command | leave empty — there are no dependencies |
| Node.js Version | 20.x or 22.x |

## `routes`, not `rewrites` — this one is a security fix

The first version used `rewrites`. That was **wrong**, and the mistake is worth
recording because it looks correct.

Vercel checks the **filesystem before applying `rewrites`**. With no build
command, Vercel serves `public/` as the static root. So `/` and
`/js/app.js` would have been served straight off the CDN, bypassing the
request handler — and with it the authentication gate, which is deny-by-default
and is supposed to cover `index.html` and every dashboard script.

`routes` is evaluated **before** the filesystem, so a single
`{"src": "/(.*)", "dest": "/api/index.js"}` genuinely puts the gate in front of
everything.

What the exposure would actually have been, measured rather than assumed: the
15 files under `public/` are UI code only — HTML, CSS and JS. No competitive
data lives there; every figure arrives from a gated `/api/*` call. So the leak
would have been the shell, not the intelligence. Still worth fixing, because
"the auth gate covers the app" should be true rather than nearly true.

### The cost of using `routes`

Vercel rejects `routes` combined with `headers`, `rewrites`, `redirects`,
`cleanUrls` or `trailingSlash`. The security headers therefore moved into
`send()` in `server.js` — which is a better place anyway: they now apply
identically when self-hosted, not just on Vercel.

## `maxDuration: 60`

Measured: a six-surface AI-visibility probe takes ~55 seconds. Each surface is
a real LLM call with web search, and they run sequentially on purpose — the
running cost total feeds the spend guard, so parallelising would let one probe
overshoot its budget cap.

60s is the Hobby ceiling. The default selection (ChatGPT + Claude) lands around
25-30s with headroom. Choosing all six on Hobby may time out; that is a plan
limit, not a bug. Pro allows 300s.

## `memory: 1024`

`data/brands.json` is ~3 MB of JSON, parsed on each cold start. The 128 MB
default is uncomfortably tight for that.

## `vercel-build` exists but does nothing to the output

`package.json` defines:

```
"vercel-build": "node -e \"require('./server.js');console.log('handler loads')\""
```

Vercel runs `vercel-build` when present, so the Build Command field can stay
empty and this still executes. It compiles nothing — it only proves the handler
imports without binding a port, which is the one failure that would otherwise
appear as every request hanging on a cold start.

Verified safe in a simulated build environment (`VERCEL=1`, no
`SESSION_SECRET`, no `.env` present): it loads cleanly rather than throwing and
failing the deploy.

## No `builds` key

`functions` + `routes` lets Vercel's zero-config Node detection pick the
runtime. A `builds` array would disable that and pin a specific
`@vercel/node` version for no benefit.
