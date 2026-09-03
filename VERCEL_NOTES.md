# Why vercel.json looks like this

## Every route goes through the function, including static files

The obvious optimisation — let Vercel's CDN serve `public/` directly and send
only `/api/*` to the function — would **bypass the authentication gate**.

This app is deny-by-default: `index.html`, `app.js` and the dashboard CSS all
require a valid session, and only `/login`, `/css/*`, `/assets/*` and
`/js/login.js` are public. That gate lives in the request handler. A static
rewrite would hand `index.html` and every data-rendering script to anyone with
the URL.

So the single `"/(.*)"` rewrite is deliberate. The cost is that a CSS file is
served by a function rather than the CDN; the benefit is that the access
control the app was built around still holds. For a seven-person internal tool
that is the right trade.

## maxDuration: 60

Measured: a six-surface AI-visibility probe takes ~55 seconds, because each
surface is a real LLM call with web search and they run sequentially (the
running total feeds the spend guard, so parallelising would let a probe
overshoot its cost cap).

60s is the Hobby-plan ceiling. The default surface selection is ChatGPT +
Claude, which lands around 25-30s and leaves headroom. Selecting all six on
Hobby may time out — that is a plan limit, not a bug. Pro allows 300.

## memory: 1024

`data/brands.json` is ~3 MB of JSON and is parsed per cold start. 1 GB keeps
parse time low; the default 128 MB is uncomfortably tight for it.

## No `builds` key

Using `functions` + `rewrites` lets Vercel's zero-config Node detection handle
the runtime. Adding a `builds` array would disable that and pin us to a
specific `@vercel/node` version for no gain.
