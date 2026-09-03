/* ==========================================================================
   AI Visibility — custom prompt search, per-surface results, citation analysis
   and the "How to rank" assets.

   These panels are ADDITIVE. The batch measurement tables render below them,
   untouched; the brand selector and every filter keep working exactly as
   before. Nothing here introduces new visual language — it reuses the card,
   panel, chip, badge and table classes already in the stylesheet.

   THE ONE RULE THAT SHAPES EVERY RENDER IN THIS FILE
   -------------------------------------------------
   All six surfaces are now measurable via DataForSEO, but a probe is billable
   and the balance is finite, so a surface can still go unqueried. When that
   happens it renders as "not checked" with the specific blocker — never as
   "not visible", and never as 0%. The two states look almost identical in a
   dashboard and mean opposite things: one is a measurement, the other is the
   absence of one.

   Where a surface goes unqueried, first-party GA4 referral traffic is shown in
   its place. That is a DIFFERENT measurement — visits that actually arrived
   from that assistant, not a rank — and it is labelled as such rather than
   quietly filling the gap.
   ========================================================================== */

(function () {
  const esc = s => String(s == null ? "" : s).replace(/[&<>"']/g, c =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

  /**
   * Surfaces in display order — the four LLMs first, since those are what the
   * question "where does Document360 appear in AI" actually means; the two
   * Google surfaces after.
   */
  const SURFACES = [
    { id: "chatgpt", label: "ChatGPT", short: "ChatGPT", color: "#10a37f" },
    { id: "claude", label: "Claude", short: "Claude", color: "#d97757" },
    { id: "gemini", label: "Gemini", short: "Gemini", color: "#8e75ff" },
    { id: "perplexity", label: "Perplexity", short: "Perplexity", color: "#20808d" },
    { id: "google_ai_overview", label: "Google AI Overview", short: "AI Overview", color: "#ea4335" },
    { id: "google_web", label: "Google / Web", short: "Web", color: "#4285f4" },
  ];

  /**
   * Selected by default. Kept to two surfaces deliberately: a six-surface probe
   * costs ~$0.18 and the DataForSEO balance is small, so an unattended click
   * should not spend a fifth of what remains. ChatGPT and Claude are the two
   * assistants most buyer evaluations actually run through.
   */
  const DEFAULT_SURFACES = ["chatgpt", "claude"];

  /** Surfaces that cost nothing, so they keep working with an empty balance. */
  const FREE_SURFACES = ["google_web"];

  const STATUS_META = {
    measured: { chip: "ok", text: "measured" },
    queued: { chip: "warn", text: "queued" },
    not_checked: { chip: "nc", text: "not checked" },
    not_available: { chip: "nc", text: "not available" },
    failed: { chip: "bad", text: "measurement failed" },
    measurement_failed: { chip: "bad", text: "measurement failed" },
  };

  /**
   * Highlight the selected brand inside an answer excerpt.
   * ESCAPE FIRST, then insert the mark — the reverse order would let answer text
   * inject markup, and the answer is third-party content.
   */
  function highlight(text, aliases) {
    let out = esc(text);
    for (const a of aliases || []) {
      if (!a) continue;
      const safe = esc(a).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      out = out.replace(new RegExp(`(${safe})`, "gi"), '<mark class="bmark">$1</mark>');
    }
    return out;
  }

  /* ------------------------------------------------------------ search bar */

  function promptSearchPanel(ctx) {
    const { DATA, STATE } = ctx;
    const brandName = (DATA.brands[STATE.brand] || {}).name || STATE.brand;

    // A few real buyer prompts as one-click starters. These are prompts, not
    // results — clicking one runs a live measurement like any typed prompt.
    const suggestions = [
      "What is the best knowledge base software for a SaaS company?",
      "Best AI documentation platform 2026",
      "Document360 vs GitBook",
      "Which knowledge base tool has approval workflows and versioning?",
      "Best help center software for customer self-service",
    ];

    return `
    <div class="card panel aiq" style="margin-bottom:14px">
      <div class="panel-h">
        <h2>Check any buyer prompt</h2>
        <span class="hint">measures ${esc(brandName)} across 6 AI surfaces</span>
      </div>

      <p class="chart-note" style="margin-top:0">
        Enter the prompt a buyer would actually type. Each selected surface is asked the question for
        real and its <b>actual answer</b> is stored — so a position here is derived from text you can
        read, not from an estimate. A full six-surface probe takes 30-60 seconds; accuracy is preferred
        over speed. Anything that cannot be queried is reported as <b>not checked</b>, never as absent.
      </p>

      ${budgetNote(esc)}

      <div class="aiq-row">
        <input type="text" id="aiPrompt" class="aiq-input" maxlength="500" spellcheck="false"
               placeholder="e.g. What is the best AI-powered documentation platform?" />
        <button class="login-btn aiq-go" id="aiProbeBtn">Check visibility</button>
      </div>

      <div class="aiq-surf">
        <span class="aiq-surf-l">Surfaces</span>
        ${SURFACES.map(s => {
          const a = (window.__d360_ai_metrics && window.__d360_ai_metrics.availability || {})[s.id] || {};
          const cost = a.estimated_cost;
          const on = DEFAULT_SURFACES.includes(s.id);
          return `<label class="aiq-cb${on ? "" : " off"}" title="${esc(a.note || "")}">
            <input type="checkbox" data-aisurf="${esc(s.id)}" ${on ? "checked" : ""} />
            <span style="color:${s.color}">●</span> ${esc(s.label)}
            ${cost != null ? `<em>$${Number(cost).toFixed(3)}</em>` : ""}
          </label>`;
        }).join("")}
        <span class="pm-spacer"></span>
        <button class="pill" data-aiselect="default">ChatGPT + Claude</button>
        <button class="pill" data-aiselect="free">free only</button>
        <button class="pill" data-aiselect="all">all six</button>
        <label class="aiq-cb" title="Use cheaper models where a cheaper one still returns a usable answer.">
          <input type="checkbox" data-aicheap /> cheaper models
        </label>
      </div>
      <p class="chart-note" style="margin:7px 0 0">
        <b>ChatGPT and Claude are selected by default</b> to conserve the DataForSEO balance — those two
        answer the question most buyers' evaluations actually run through. Add the others when you want
        full coverage. <b>Free only</b> uses the sources that cost nothing, so it keeps working after the
        balance runs out.
      </p>

      <div class="aiq-sugg">
        ${suggestions.map(s => `<button class="pill" data-aisugg="${esc(s)}">${esc(s)}</button>`).join("")}
      </div>

      <div class="login-msg" id="aiProbeMsg" style="margin-top:10px"></div>
      <div id="aiProbeResult"></div>
    </div>`;
  }

  /**
   * Billing state. Measuring AI visibility costs money per call, so the balance
   * and what remains are shown before the reader spends any — a probe that
   * silently fails on an empty account would look like a broken feature.
   */
  function budgetNote(esc) {
    const h = window.__d360_api_health;
    if (!h) return "";
    const dfs = (h.sources || []).find(s => s.name === "DataForSEO");
    if (!dfs) return "";
    if (dfs.state === "BROKEN") {
      return `<div class="cav warn" style="margin:12px 0 0">
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"/><path d="M12 16v-4M12 8h.01"/></svg>
        <span><b>AI surfaces cannot be measured:</b> ${esc(dfs.detail)}. ${esc(dfs.fix || "")}</span>
      </div>`;
    }
    const left = dfs.probes_remaining;
    if (left == null) return "";
    return `<div class="cav ${left < 5 ? "warn" : "info"}" style="margin:12px 0 0">
      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"/><path d="M12 16v-4M12 8h.01"/></svg>
      <span>DataForSEO balance <b>$${Number(dfs.balance).toFixed(4)}</b> —
        about <b>${left}</b> more full six-surface probe(s) at $${Number(dfs.per_probe_cost).toFixed(4)} each.
        Repeating a prompt is <b>free</b> (answers are cached for 7 days).
        ${left < 5 ? "Top up the DataForSEO account, or deselect the expensive surfaces below." : ""}</span>
    </div>`;
  }

  /* ------------------------------------------------- one surface's result */

  function surfaceCard(surface, p, brandId, brandName, prompt) {
    const meta = STATUS_META[p.status] || { chip: "nc", text: p.status || "unknown" };
    const b = (p.brands || {})[brandId] || null;
    const measured = p.status === "measured";

    // Visibility line. Only a measured surface may state visible/not visible.
    let verdict;
    if (!measured) {
      // The chip already carries the status word, so the verdict explains what
      // the status MEANS rather than repeating it.
      verdict = `<div class="ais-verdict unknown">
        <b>Not measured</b>
        <span>${p.status === "queued"
          ? "awaiting the Claude Code pass"
          : "this surface was not queried — not an absence"}</span>
      </div>`;
    } else if (b && b.visible) {
      verdict = `<div class="ais-verdict yes">
        <b>Visible</b>
        <span>${b.position ? "position #" + b.position : "position not determined"}</span>
      </div>`;
    } else {
      verdict = `<div class="ais-verdict no">
        <b>Not visible</b>
        <span>measured, ${esc(brandName)} absent</span>
      </div>`;
    }

    const competitors = measured
      ? Object.entries(p.brands || {})
          .filter(([id, v]) => id !== brandId && v.visible)
          .sort((a, c) => (a[1].position || 99) - (c[1].position || 99))
      : [];

    const cites = (p.citations || []).slice(0, 6);

    return `<article class="card ais">
      <div class="ais-head">
        <span class="ais-mark" style="color:${surface.color}">${esc(surface.short.charAt(0))}</span>
        <div class="ais-id">
          <h3>${esc(surface.label)}</h3>
          <!-- Only a real timestamp goes here. Repeating "not checked" would
               state the same fact three times in one card (chip, timestamp,
               verdict), which reads as noise rather than emphasis. -->
          <span class="ais-when">${p.checked_at ? relTime(p.checked_at) : ""}</span>
        </div>
        <span class="chip ${meta.chip}">${esc(meta.text)}</span>
      </div>

      ${verdict}

      ${measured && p.no_ai_overview ? `
        <p class="ais-why">${esc(p.note || "Google returned no AI Overview for this query.")}</p>` : ""}

      ${measured && b && b.visible && b.evidence ? `
        <blockquote class="ais-ev">${highlight(b.evidence, [b.matched_alias, brandName])}
          ${b.evidence_url ? `<a href="${esc(b.evidence_url)}" target="_blank" rel="noopener noreferrer">cited source</a>` : ""}
        </blockquote>` : ""}

      ${!measured ? `
        <p class="ais-why">${esc(p.reason || "No reason recorded.")}</p>
        ${p.how_to_enable ? `<p class="ais-enable"><b>To enable:</b> ${esc(p.how_to_enable)}</p>` : ""}` : ""}

      ${fallbackBlock(p.fallback || p.referral_traffic, measured)}

      ${competitors.length ? `
        <div class="ais-sec">
          <div class="ev-h">Competitors appearing</div>
          <div class="ais-comps">
            ${competitors.map(([id, v]) => `<span class="pm-tag cmp">${esc(nameOf(id))}${v.position ? ` #${v.position}` : ""}</span>`).join("")}
          </div>
        </div>` : measured ? `
        <div class="ais-sec"><div class="ev-h">Competitors appearing</div>
          <p class="chart-note" style="margin:0">None of the other six tracked products appeared either.</p></div>` : ""}

      ${cites.length ? `
        <div class="ais-sec">
          <div class="ev-h">Cited sources <span class="muted">(${(p.citations || []).length} total)</span></div>
          <ol class="ais-cites">
            ${cites.map(c => `<li>
              ${c.domain
                ? `<a href="${esc(c.url)}" target="_blank" rel="noopener noreferrer">${esc(c.domain)}</a>`
                /* A redirect wrapper is not a publisher, so it is not named as
                   one — the link still works, the source is just unknown. */
                : `<a href="${esc(c.url)}" target="_blank" rel="noopener noreferrer">publisher not recoverable</a>`}
              ${(c.mentions || []).length
                ? `<span class="ais-cm">${(c.mentions || []).map(m => esc(nameOf(m))).join(", ")}</span>`
                /* NOT "no tracked product": only the title and domain were
                   available, not the page body, so which products this source
                   names was never determined. Saying "none" would be a claim. */
                : `<span class="muted" title="Only the citation's title and domain were available — the page body was not fetched, so which products it names is undetermined.">products undetermined</span>`}
            </li>`).join("")}
          </ol>
          <p class="chart-note" style="margin:6px 0 0">Product tags come from each citation's title and
          domain only; the cited pages themselves were not fetched.</p>
        </div>` : ""}

      <div class="ais-foot">
        ${p.model ? `<span class="pm-tag" title="The exact model that produced this answer">${esc(p.model)}</span>` : ""}
        ${p.confidence != null ? `<span class="pm-tag">confidence ${Math.round(p.confidence * 100)}%</span>` : ""}
        ${p.from_cache ? `<span class="pm-tag" title="Served from the 7-day answer cache — no new API spend">cached</span>` : ""}
        ${p.cost ? `<span class="pm-tag" title="What this measurement cost">$${Number(p.cost).toFixed(4)}</span>` : ""}
        <span class="pm-spacer"></span>
        ${measured && p.answer_text
          /* The answer itself is now the primary action. Redirecting the reader
             to go and re-ask the question was only ever a stand-in for not
             having the answer — we have it, so we show it. */
          ? `<button class="ais-open" data-aianswer="${esc(surface.id)}">
               View full answer
               <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M4 6h16M4 12h16M4 18h10"/></svg>
             </button>`
          : ""}
        ${p.open_search
          /* Kept, but secondary and quiet: useful for spot-checking a result by
             hand, not the point of the card. */
          ? `<a class="ais-ext" href="${esc(p.open_search)}" target="_blank" rel="noopener noreferrer"
                title="Open this query on ${esc(surface.label)} to check it yourself">open ↗</a>`
          : ""}
      </div>
    </article>`;
  }


  let NAMES = {};
  function nameOf(id) { return NAMES[id] || id; }

  /**
   * First-party referral traffic for a surface.
   *
   * Visually distinct from the verdict block above it, because it answers a
   * different question. When the surface WAS measured this is corroboration;
   * when it was not, it is the most useful honest thing available. Either way it
   * is labelled as traffic, never as a rank.
   */
  function fallbackBlock(fb, measured) {
    if (!fb) return "";
    return `
      <div class="ais-fp${measured ? "" : " primary"}">
        <div class="ais-fp-h">
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M3 3v18h18"/><path d="m7 14 4-4 3 3 5-6"/></svg>
          First-party traffic${measured ? "" : " (measured instead)"}
        </div>
        <div class="ais-fp-n"><b>${Number(fb.sessions).toLocaleString("en-US")}</b> session(s) in 90 days
          ${fb.share_of_ai_pct != null ? `<span class="muted">· ${fb.share_of_ai_pct}% of all AI traffic</span>` : ""}
        </div>
        ${(fb.top_landing_pages || []).length ? `
          <div class="ais-fp-p">${fb.top_landing_pages.slice(0, 3).map(p =>
            `<span title="${esc(p.page)}">${esc(String(p.page).slice(0, 28))} <b>${p.sessions}</b></span>`).join("")}</div>` : ""}
        <p class="ais-fp-c">${esc(fb.caveat)}</p>
      </div>`;
  }

  function relTime(iso) {
    const t = new Date(iso).getTime();
    if (isNaN(t)) return String(iso);
    const s = Math.floor((Date.now() - t) / 1000);
    if (s < 60) return "just now";
    if (s < 3600) return Math.floor(s / 60) + "m ago";
    if (s < 86400) return Math.floor(s / 3600) + "h ago";
    return Math.floor(s / 86400) + "d ago";
  }

  /* --------------------------------------------- rendered probe result set */

  function renderProbe(result, ctx) {
    const { DATA, STATE } = ctx;
    NAMES = Object.fromEntries(Object.entries(DATA.brands).map(([k, v]) => [k, v.name]));
    const brandId = result.brand_id || STATE.brand;
    const brandName = (DATA.brands[brandId] || {}).name || brandId;

    const present = SURFACES.filter(s => result.providers[s.id]);
    const measuredCount = present.filter(s => result.providers[s.id].status === "measured").length;
    const total = present.length;

    // Where the brand IS visible, and at what rank — the headline answer.
    const visibleIn = present.filter(s => {
      const p = result.providers[s.id];
      const b = p.status === "measured" && (p.brands || {})[brandId];
      return b && b.visible;
    });

    const cost = result.cost || null;

    return `
    <div class="aip-head">
      <div>
        <div class="aip-prompt">“${esc(result.prompt)}”</div>
        <div class="aip-meta">
          measured for <b>${esc(brandName)}</b> ·
          ${measuredCount} of ${total} surface(s) measured ·
          ${relTime(result.probed_at)}
          ${cost && cost.actual != null ? ` · cost $${Number(cost.actual).toFixed(4)}` : ""}
        </div>
      </div>
    </div>

    <div class="aip-score">
      <div class="aip-big">
        <b>${visibleIn.length}</b><span>of ${measuredCount} measured surface${measuredCount === 1 ? "" : "s"}</span>
      </div>
      <div class="aip-chips">
        ${present.map(s => {
          const p = result.providers[s.id];
          if (p.status !== "measured") {
            return `<span class="aip-chip nc" title="${esc(p.reason || "not checked")}">${esc(s.short)} —</span>`;
          }
          const b = (p.brands || {})[brandId];
          return b && b.visible
            ? `<span class="aip-chip yes" style="--sc:${s.color}">${esc(s.short)} #${b.position}</span>`
            : `<span class="aip-chip no">${esc(s.short)} absent</span>`;
        }).join("")}
      </div>
    </div>

    ${measuredCount < total ? `
    <div class="cav warn" style="margin:10px 0 12px">
      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"/><path d="M12 16v-4M12 8h.01"/></svg>
      <span><b>${total - measuredCount} of ${total}</b> surface(s) could not be queried and are marked
        <b>not checked</b> with the exact blocker. They are <b>not</b> counted as “absent”, because that
        would report a measurement this system never made — and they are excluded from the rates above.</span>
    </div>` : ""}

    <div class="ais-grid">
      ${present.map(s =>
        surfaceCard(
          { ...s, deeplink_basis: ((result.availability && result.availability[s.id]) || {}).deeplink_basis },
          result.providers[s.id], brandId, brandName, result.prompt
        )
      ).join("")}
    </div>

    ${gapPanel(result, brandId, brandName)}`;
  }

  /**
   * The complete answer, shown in the existing provenance modal.
   * This is the evidence every rank on the card was derived from, so it must be
   * readable in full rather than summarised.
   */
  function answerModal(surfaceId, result, brandId, brandName) {
    const p = (result.providers || {})[surfaceId];
    if (!p) return "";
    const s = SURFACES.find(x => x.id === surfaceId) || { label: surfaceId, color: "var(--brand)" };
    const b = (p.brands || {})[brandId];

    const named = Object.entries(p.brands || {})
      .filter(([, v]) => v.visible)
      .sort((a, c) => (a[1].position || 99) - (c[1].position || 99));

    // Matches the markup showProvenance() uses, so the existing modal styling
    // and its close handling apply unchanged.
    return `
      <button class="close" data-mclose>×</button>
      <h2>${esc(s.label)} — full answer</h2>
      <p class="genby">This is the answer the measurement was taken from, stored verbatim. Every
      position on the card is derived from this text.</p>
      <p class="aip-prompt" style="font-size:13.5px">“${esc(result.prompt)}”</p>
      <div class="aip-meta" style="margin-bottom:12px">
        ${p.model ? `model <b>${esc(p.model)}</b> · ` : ""}
        ${p.web_search ? "web search enabled · " : ""}
        ${p.answer_length ? `${p.answer_length} chars · ` : ""}
        ${p.checked_at ? relTime(p.checked_at) : ""}
        ${p.cost ? ` · $${Number(p.cost).toFixed(4)}` : ""}
      </div>

      <div class="ev-h">Where each tracked product appeared</div>
      <table class="ptable"><tbody>
        ${named.length ? named.map(([id, v]) => `<tr>
          <td>${esc(nameOf(id))}${id === brandId ? ' <span class="badge brand xs">you</span>' : ""}</td>
          <td class="tnum">#${v.position}</td>
          <td class="muted" style="font-size:11px">${esc(v.matched_alias || "")}</td>
        </tr>`).join("") : `<tr><td colspan="3" class="muted">No tracked product was named in this answer.</td></tr>`}
      </tbody></table>
      <p class="chart-note">Position is the order of first appearance in the answer text below — a
      reproducible reading of prose, not an assigned score. ${b && b.visible
        ? `${esc(brandName)} first appears at character ${p.answer_text.toLowerCase().indexOf(String(b.matched_alias || brandName).toLowerCase())}.`
        : ""}</p>

      ${(p.other_products_named || []).length ? `
        <div class="ev-h" style="margin-top:14px">Other products named (untracked)</div>
        <div class="ais-comps">${p.other_products_named.map(x => `<span class="pm-tag">${esc(x)}</span>`).join("")}</div>` : ""}

      <div class="ev-h" style="margin-top:14px">The answer, verbatim
        <button class="as-copy" data-ascopy="${esc(p.answer_text || "")}">copy</button>
      </div>
      <pre class="as-pre" style="max-height:420px">${highlight(p.answer_text || "", [b && b.matched_alias, brandName])}</pre>

      ${(p.citations || []).length ? `
        <div class="ev-h" style="margin-top:14px">Citations the model returned (${p.citations.length})</div>
        <ol class="ais-cites">
          ${p.citations.map(c => `<li>
            <a href="${esc(c.url)}" target="_blank" rel="noopener noreferrer">${esc(c.domain || "publisher not recoverable")}</a>
            ${c.domain_recovered_from ? `<span class="muted" title="Recovered from the citation ${esc(c.domain_recovered_from)} because the URL is a redirect wrapper"> (via ${esc(c.domain_recovered_from)})</span>` : ""}
            ${c.title ? `<span class="muted"> — ${esc(String(c.title).slice(0, 80))}</span>` : ""}
            ${(c.mentions || []).length ? `<span class="ais-cm">${c.mentions.map(m => esc(nameOf(m))).join(", ")}</span>` : ""}
          </li>`).join("")}
        </ol>` : `<p class="chart-note">This surface returned no citation URLs.</p>`}

      <p class="chart-note" style="margin-top:12px">${esc(p.method || "")}</p>`;
  }

  /**
   * "How to rank" — shown beside a prompt the brand does not rank for.
   * Assets already generated for this prompt are rendered inline; otherwise the
   * panel states exactly what produces them rather than inventing advice here.
   */
  function gapPanel(result, brandId, brandName) {
    const web = result.providers.google_web;
    if (!web || web.status !== "measured") return "";
    const me = (web.brands || {})[brandId];
    if (me && me.visible) {
      return `<div class="cav info" style="margin-top:12px">
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M20 6 9 17l-5-5"/></svg>
        <span><b>${esc(brandName)} ranks #${me.position}</b> for this prompt in the measured web results, so no
        “how to rank” plan is generated — the gap analysis targets prompts where it is absent.</span>
      </div>`;
    }

    const assets = (window.__d360_assets && window.__d360_assets.recommendations || [])
      .filter(a => a.prompt === result.prompt);

    const gaps = (web.citations || []).filter(c => (c.mentions || []).length && !(c.mentions || []).includes(brandId));

    return `
    <details class="howto" ${assets.length ? "open" : ""}>
      <summary>
        <span class="howto-t">How to rank for this prompt</span>
        <span class="chip ${assets.length ? "ok" : "warn"}">${assets.length ? `${assets.length} asset(s) ready` : "not generated yet"}</span>
      </summary>

      <div class="howto-body">
        <p class="chart-note" style="margin-top:0">
          ${esc(brandName)} is absent from the measured results for this prompt. These are the
          <b>${gaps.length}</b> ranking source(s) that name a competitor and omit it — the concrete targets any
          plan has to address.
        </p>

        ${gaps.length ? `
        <div class="tbl-scroll" style="max-height:220px"><table class="ptable">
          <thead><tr><th>#</th><th>Source</th><th>Names</th></tr></thead>
          <tbody>${gaps.slice(0, 12).map(c => `<tr>
            <td class="tnum">${c.rank}</td>
            <td class="urlcell"><a href="${esc(c.url)}" target="_blank" rel="noopener noreferrer">${esc(c.domain || c.url)}</a></td>
            <td>${(c.mentions || []).map(m => esc(nameOf(m))).join(", ")}</td>
          </tr>`).join("")}</tbody>
        </table></div>` : ""}

        ${assets.length
          ? `<div class="howto-assets">${assets.map(assetCard).join("")}</div>`
          : `<p class="ais-enable" style="margin-top:12px">
               <b>To generate the assets:</b> run <code>npm run assets:build</code>, let Claude Code fill
               <code>collectors/store/claude-rank-assets.json</code>, then <code>npm run assets:apply</code>.
               Each asset must cite one of the ranking URLs above or it is rejected — which is why none are
               shown here rather than generic advice being displayed.
             </p>`}
      </div>
    </details>`;
  }

  /* ---------------------------------------------------------- asset render */

  /** Render the produced asset in the shape its channel actually needs. */
  function assetBody(type, a) {
    const block = (label, val) => val
      ? `<div class="as-f"><div class="as-fl">${esc(label)}</div><div class="as-fv">${esc(val)}</div></div>` : "";
    const list = (label, arr) => Array.isArray(arr) && arr.length
      ? `<div class="as-f"><div class="as-fl">${esc(label)}</div><ol class="as-ol">${arr.map(x =>
          `<li>${esc(typeof x === "string" ? x : (x.heading || x.title || JSON.stringify(x)))}${
            typeof x === "object" && x.detail ? `<div class="as-sub">${esc(x.detail)}</div>` : ""}</li>`).join("")}</ol></div>` : "";
    const copyBlock = (label, val) => val
      ? `<div class="as-f"><div class="as-fl">${esc(label)}
           <button class="as-copy" data-ascopy="${esc(String(val).slice(0, 100000))}">copy</button></div>
           <pre class="as-pre">${esc(val)}</pre></div>` : "";

    switch (type) {
      case "linkedin_post":
        return copyBlock("Post copy", a.body);
      case "linkedin_influencer":
        return copyBlock("Post copy", a.body) + copyBlock("Outreach message", a.outreach_message);
      case "youtube_video":
        return block("Title", a.title) + copyBlock("Description", a.description) + list("Script outline", a.outline);
      case "reddit_post":
        return block("Subreddit", a.subreddit) + block("Title", a.title) + copyBlock("Post body", a.body);
      case "blog":
        return block("Title", a.title) + list("Outline", a.outline) + copyBlock("Draft", a.draft);
      case "comparison_page":
      case "landing_page":
      case "case_study":
        return block("Title", a.title) + list("Structure", a.structure) + copyBlock("Copy", a.copy);
      case "docs_page":
        return block("Title", a.title) + list("Outline", a.outline) + copyBlock("Copy", a.copy);
      case "seo_entity":
        return list("Target keywords", a.target_keywords) + list("Target entities", a.target_entities) +
          copyBlock("Citation strategy", a.citation_strategy);
      default:
        return `<pre class="as-pre">${esc(JSON.stringify(a, null, 2))}</pre>`;
    }
  }

  function assetCard(r) {
    return `<article class="card asset">
      <div class="as-head">
        <span class="pm-tag cmp">${esc(r.asset_label || r.asset_type)}</span>
        ${r.owner ? `<span class="pm-tag">${esc(r.owner)}</span>` : ""}
        ${r.effort ? `<span class="pm-tag">${esc(r.effort)} effort</span>` : ""}
      </div>
      <h4 class="as-title">${esc(r.title)}</h4>
      <p class="as-why"><b>Why this could work:</b> ${esc(r.why)}</p>
      <div class="as-fields">${assetBody(r.asset_type, r.asset || {})}</div>
      ${(r.evidence || []).length ? `
        <div class="as-ev">
          <div class="ev-h">Grounded in ${r.evidence.length} ranking source(s)</div>
          ${r.evidence.map(e => `<div class="as-evi">
            <a href="${esc(e.url)}" target="_blank" rel="noopener noreferrer">${esc(e.domain || e.url)}</a>
            <span class="muted">${e.rank ? `#${e.rank}` : ""} ${e.source_type ? `· ${esc(String(e.source_type).replace(/_/g, " "))}` : ""}${
              (e.names || []).length ? ` · names ${e.names.map(esc).join(", ")}` : ""}</span>
          </div>`).join("")}
        </div>` : ""}
    </article>`;
  }

  /* ------------------------------------------------------ metrics + history */

  function metricsPanel(m, availability) {
    if (!m || !m.has_data) {
      return `<div class="card panel" style="margin-bottom:14px">
        <div class="panel-h"><h2>AI visibility over time</h2><span class="chip nc">no probes yet</span></div>
        <div class="empty mini"><p>No prompt has been probed yet.</p>
        <p class="sub">Run a prompt above. Every probe is stored, and these metrics build up from the
        stored history — they are never estimated from a single sample.</p></div>
      </div>`;
    }
    const cell = (label, val, suffix = "", note = null) => `
      <div class="aim-cell">
        <div class="aim-v">${val == null ? "—" : val}${val == null ? "" : suffix}</div>
        <div class="aim-l">${esc(label)}</div>
        ${note ? `<div class="aim-n">${esc(note)}</div>` : ""}
      </div>`;

    return `
    <div class="card panel" style="margin-bottom:14px">
      <div class="panel-h">
        <h2>AI visibility over time — ${esc(m.brand)}</h2>
        <span class="hint">${m.prompts_probed} prompt(s) · ${m.checks_measured} measured check(s)</span>
      </div>

      <div class="aim-grid">
        ${cell("AI mention rate", m.ai_mention_rate, "%")}
        ${cell("Recommendation rate", m.recommendation_rate, "%", "top-5 placements")}
        ${cell("Average position", m.average_position)}
        ${cell("Top-3 rate", m.top3_rate, "%")}
        ${cell("Top-5 rate", m.top5_rate, "%")}
        ${cell("Share of AI voice", m.share_of_ai_voice, "%", "vs the other 6 products")}
      </div>

      <p class="chart-note">
        Every rate is computed over the <b>${m.checks_measured}</b> checks that were actually measured, not the
        ${m.checks_measured + m.checks_not_measured} attempted. Coverage is <b>${m.coverage_pct == null ? "—" : m.coverage_pct + "%"}</b> —
        ${m.checks_not_measured} check(s) could not be queried and are excluded from the denominators rather than
        counted as absences.
      </p>
    </div>`;
  }

  function historyPanel(hist, brandId) {
    const entries = (hist && hist.entries) || [];
    if (!entries.length) return "";
    return `
    <div class="card panel" style="margin-bottom:14px">
      <div class="panel-h"><h2>Probe history</h2><span class="hint">${hist.count} stored</span></div>
      <div class="tbl-scroll" style="max-height:300px"><table class="ptable">
        <thead><tr><th>Prompt</th><th>When</th><th>Web result</th><th>Surfaces measured</th></tr></thead>
        <tbody>${entries.slice(0, 40).map(e => {
          const web = e.providers.google_web || {};
          const me = (web.brands || {})[brandId];
          const measured = Object.values(e.providers).filter(p => p.status === "measured").length;
          return `<tr>
            <td class="q"><button class="linky" data-aihist="${esc(e.id)}">${esc(e.prompt)}</button></td>
            <td class="muted" style="font-size:11.5px;white-space:nowrap">${relTime(e.probed_at)}</td>
            <td>${web.status !== "measured"
              ? `<span class="chip nc">not measured</span>`
              : me && me.visible
                ? `<span class="pos-pill${me.position === 1 ? " rank1" : ""}">#${me.position}</span>`
                : `<span class="absent">absent</span>`}</td>
            <td class="tnum">${measured}/6</td>
          </tr>`;
        }).join("")}</tbody>
      </table></div>
      <p class="chart-note">Click a prompt to reload its stored result. Nothing here is re-measured on click —
      it is the recorded measurement with its original timestamp.</p>
    </div>`;
  }

  /* ------------------------------------------- first-party AI traffic panel */

  /**
   * The outcome side of AI visibility: how many people actually arrived from
   * each assistant, and which page they landed on.
   *
   * This is the only panel in the dashboard built from first-party data — GA4
   * recorded these visits, nothing was scraped and no model was asked. It is
   * also free to query, so it keeps working when the DataForSEO balance does not.
   */
  function referralPanel(ref, brandId, brandName) {
    if (!ref) return "";

    // GA4 covers our own property only. Saying so is required, because a zero
    // here for a competitor would be a fabrication rather than a measurement.
    if (brandId !== "document360") {
      return `
      <div class="card panel" style="margin-bottom:14px">
        <div class="panel-h"><h2>AI referral traffic</h2><span class="chip nc">not available for ${esc(brandName)}</span></div>
        <div class="empty mini">
          <p>First-party analytics covers Document360's own property only.</p>
          <p class="sub">There is no way to see how much traffic an AI assistant sends to a competitor's
          site, so this is <b>unavailable</b> for ${esc(brandName)} rather than zero. Switch the product
          selector to Document360 to see it.</p>
        </div>
      </div>`;
    }

    const max = Math.max(1, ...(ref.surfaces || []).map(s => s.sessions));
    const spark = (ref.by_date || []).slice(-60);
    const sparkMax = Math.max(1, ...spark.map(d => d.sessions));

    return `
    <div class="card panel" style="margin-bottom:14px">
      <div class="panel-h">
        <h2>AI referral traffic — what actually arrived</h2>
        <span class="hint">${Number(ref.ai_sessions).toLocaleString("en-US")} of ${Number(ref.total_sessions).toLocaleString("en-US")} sessions · last 90 days</span>
      </div>

      <p class="chart-note" style="margin-top:0">
        The outcome side of AI visibility: real visits recorded by Google Analytics 4, not model answers.
        <b>${ref.ai_share_pct}%</b> of all traffic to the Document360 property arrived from an AI assistant.
        Nothing here is scraped or inferred.
      </p>

      <div class="fp-grid">
        ${(ref.surfaces || []).map(s => {
          const c = (SURFACES.find(x => x.id === s.id) || {}).color || "var(--brand)";
          return `<div class="fp-row">
            <span class="fp-l" style="color:${c}">● ${esc(s.label)}</span>
            <span class="fp-bar"><i style="width:${((s.sessions / max) * 100).toFixed(1)}%;background:${c}"></i></span>
            <span class="fp-n tnum">${Number(s.sessions).toLocaleString("en-US")}</span>
            <span class="fp-p muted">${s.share_of_ai_pct}%</span>
          </div>`;
        }).join("")}
      </div>

      ${spark.length ? `
        <div class="ev-h" style="margin-top:16px">AI sessions per day (last ${spark.length})</div>
        <div class="fp-spark">${spark.map(d =>
          `<i style="height:${Math.max(3, (d.sessions / sparkMax) * 100).toFixed(1)}%" title="${esc(d.date)}: ${d.sessions} session(s)"></i>`).join("")}</div>` : ""}

      <div class="ev-h" style="margin-top:16px">Where AI assistants send people</div>
      <div class="tbl-scroll" style="max-height:260px"><table class="ptable">
        <thead><tr><th>Landing page</th><th>Sessions</th><th>What it signals</th></tr></thead>
        <tbody>${(ref.top_landing_pages || []).slice(0, 14).map(p => {
          // A page-level read of intent, from the path only — no guessing.
          const signal = p.page === "(not set)"
            ? '<span class="muted">landing page not recorded by GA4</span>'
            : /^\/pricing/.test(p.page) ? '<span class="pm-tag intent">pricing — buying intent</span>'
              : /^\/signup|^\/trial|^\/demo/.test(p.page) ? '<span class="pm-tag intent">signup or demo</span>'
                : /^\/(docs|apidocs)/.test(p.page) ? "documentation"
                  : /^\/blog/.test(p.page) ? "blog content"
                    : p.page === "/" ? "homepage" : "other";
          return `<tr>
            <td class="urlcell">${p.page === "(not set)" ? '<span class="muted">(not set)</span>'
              : `<a href="https://document360.com${esc(p.page)}" target="_blank" rel="noopener noreferrer">${esc(p.page)}</a>`}</td>
            <td class="tnum">${p.sessions}</td>
            <td>${signal}</td>
          </tr>`;
        }).join("")}</tbody>
      </table></div>

      <p class="chart-note">${esc(ref.scope_limit)}</p>
    </div>`;
  }

  /* ------------------------------------------------- citation analysis panel */

  function citationPanel(cit, brandId, brandName) {
    if (!cit || !(cit.prompts || []).length) return "";
    const auth = (cit.domain_authority || []).slice(0, 15);

    return `
    <div class="card panel" style="margin-bottom:14px">
      <div class="panel-h">
        <h2>Citation analysis</h2>
        <span class="hint">which domains decide AI answers in this category</span>
      </div>
      <p class="chart-note" style="margin-top:0">
        Every row is a domain that actually ranked for a probed buyer prompt. “Names ${esc(brandName)}”
        counts the prompts where that domain's ranking page mentioned it — the gap between the two columns
        is the citation opportunity.
      </p>
      <div class="tbl-scroll" style="max-height:360px"><table class="ptable wide">
        <thead><tr><th>Domain</th><th>Type</th><th>Times ranked</th><th>Best rank</th><th>Names ${esc(brandName)}</th><th>Names competitors</th></tr></thead>
        <tbody>${auth.map(d => `<tr class="${d.mentions_us ? "" : "gaprow"}">
          <td><a href="${esc(d.example_url)}" target="_blank" rel="noopener noreferrer">${esc(d.domain)}</a></td>
          <td class="muted" style="font-size:11.5px">${esc(String(d.source_type || "").replace(/_/g, " "))}</td>
          <td class="tnum">${d.times_ranked}</td>
          <td class="tnum">${d.best_rank == null ? "—" : "#" + d.best_rank}</td>
          <td>${d.mentions_us
            ? `<span class="badge pos dot">${d.mentions_us}</span>`
            : `<span class="chip zero">0</span>`}</td>
          <td class="tnum">${d.mentions_competitors}</td>
        </tr>`).join("")}</tbody>
      </table></div>
    </div>`;
  }

  /* ------------------------------------------------------------------ wiring */

  async function loadAiSide() {
    // Loaded once per view render; each is independent so one failure does not
    // blank the others.
    const get = async (u, fallback) => {
      try { const r = await fetch(u); return r.ok ? await r.json() : fallback; }
      catch (e) { return fallback; }
    };
    const [metrics, hist, assets, health, referrals] = await Promise.all([
      get("/api/ai/metrics", null),
      get("/api/ai/history", { entries: [], count: 0 }),
      get("/api/ai/assets", { recommendations: [] }),
      get("/api/health", null),
      get("/api/ai/referrals", null),
    ]);
    window.__d360_ai_metrics = metrics;
    window.__d360_ai_history = hist;
    window.__d360_assets = assets;
    window.__d360_api_health = health;
    window.__d360_referrals = referrals && referrals.ok ? referrals : null;
  }

  async function loadCitations(brandId) {
    try {
      const r = await fetch("/api/ai/citations?brand=" + encodeURIComponent(brandId));
      window.__d360_citations = r.ok ? await r.json() : null;
    } catch (e) { window.__d360_citations = null; }
  }

  function bindAI(ctx) {
    const msg = document.getElementById("aiProbeMsg");
    const out = document.getElementById("aiProbeResult");
    const input = document.getElementById("aiPrompt");
    const btn = document.getElementById("aiProbeBtn");
    const show = (t, k) => { if (msg) { msg.innerHTML = t; msg.className = "login-msg " + (k || ""); } };

    async function runProbe(prompt) {
      if (!prompt || !prompt.trim()) { show("Enter a prompt first.", "err"); return; }

      const surfaces = [...document.querySelectorAll("[data-aisurf]")]
        .filter(x => x.checked).map(x => x.dataset.aisurf);
      if (!surfaces.length) { show("Select at least one surface to check.", "err"); return; }
      const cheap = !!(document.querySelector("[data-aicheap]") || {}).checked;

      if (btn) { btn.disabled = true; btn.textContent = "Measuring…"; }
      show(`Asking ${surfaces.length} surface(s) this question for real. 30-60 seconds — each answer is fetched, not estimated.`);
      if (out) out.innerHTML = "";
      try {
        const r = await fetch("/api/ai/probe", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ prompt: prompt.trim(), brand_id: ctx.STATE.brand, surfaces, cheap }),
        });
        const j = await r.json();
        if (!j.ok) { show(esc(j.error || "The probe failed."), "err"); return; }
        show(j.cost && j.cost.actual
          ? `Measured ${j.surfaces_measured}/${j.surfaces_requested.length} surface(s) — cost $${Number(j.cost.actual).toFixed(4)}, balance now $${Number(j.cost.balance_after).toFixed(4)}.`
          : "", j.cost && j.cost.actual ? "ok" : "");
        window.__d360_last_probe = j;
        if (out) out.innerHTML = renderProbe(j, ctx);
        // Refresh the derived panels so the new probe is reflected in metrics.
        await loadAiSide();
        await loadCitations(ctx.STATE.brand);
      } catch (e) {
        show("Request failed: " + esc(e.message), "err");
      } finally {
        if (btn) { btn.disabled = false; btn.textContent = "Check visibility"; }
      }
    }

    if (btn) btn.onclick = () => runProbe(input ? input.value : "");
    if (input) input.onkeydown = e => { if (e.key === "Enter") runProbe(input.value); };

    document.querySelectorAll("[data-aisugg]").forEach(b => {
      b.onclick = () => { if (input) input.value = b.dataset.aisugg; runProbe(b.dataset.aisugg); };
    });

    // Surface presets. Selecting a set is one click rather than six.
    document.querySelectorAll("[data-aiselect]").forEach(b => {
      b.onclick = () => {
        const set = { default: DEFAULT_SURFACES, free: FREE_SURFACES, all: SURFACES.map(s => s.id) }[b.dataset.aiselect] || DEFAULT_SURFACES;
        document.querySelectorAll("[data-aisurf]").forEach(cb => {
          cb.checked = set.includes(cb.dataset.aisurf);
          cb.closest(".aiq-cb").classList.toggle("off", !cb.checked);
        });
      };
    });

    // Keep the dimmed styling in sync when a box is toggled by hand.
    document.querySelectorAll("[data-aisurf]").forEach(cb => {
      cb.onchange = () => cb.closest(".aiq-cb").classList.toggle("off", !cb.checked);
    });

    // Re-render a stored probe from history.
    document.querySelectorAll("[data-aihist]").forEach(b => {
      b.onclick = () => {
        const h = window.__d360_ai_history;
        const e = (h && h.entries || []).find(x => x.id === b.dataset.aihist);
        if (!e) return;
        window.__d360_last_probe = e;
        if (out) out.innerHTML = renderProbe(e, ctx);
        if (input) input.value = e.prompt;
        const panel = document.querySelector(".aiq");
        if (panel) panel.scrollIntoView({ behavior: "smooth", block: "start" });
      };
    });

    /* ---------------------------------------------------- full-answer modal */
    // The answer is now held locally, so opening it is a local render rather
    // than sending the reader off to re-ask the question somewhere else.
    document.querySelectorAll("[data-aianswer]").forEach(b => {
      b.onclick = () => {
        const probeResult = window.__d360_last_probe;
        if (!probeResult) return;
        const card = document.getElementById("modalCard");
        const modal = document.getElementById("modal");
        if (!card || !modal) return;
        card.innerHTML = answerModal(
          b.dataset.aianswer, probeResult,
          probeResult.brand_id || ctx.STATE.brand,
          nameOf(probeResult.brand_id || ctx.STATE.brand)
        );
        modal.classList.add("open");
        // Copy buttons inside the modal are created after the page-level bind.
        card.querySelectorAll("[data-ascopy]").forEach(cb => {
          cb.onclick = async () => {
            try {
              await navigator.clipboard.writeText(cb.dataset.ascopy);
              const t = cb.textContent; cb.textContent = "copied";
              setTimeout(() => { cb.textContent = t; }, 1400);
            } catch (e) { /* clipboard blocked; the text is selectable */ }
          };
        });
      };
    });

    /* --------------------------------------------------------- copy buttons */
    document.querySelectorAll("[data-ascopy]").forEach(b => {
      b.onclick = async () => {
        try {
          await navigator.clipboard.writeText(b.dataset.ascopy);
          const t = b.textContent;
          b.textContent = "copied";
          setTimeout(() => { b.textContent = t; }, 1400);
        } catch (e) { /* clipboard blocked; the text is selectable anyway */ }
      };
    });
  }

  window.D360AI = {
    SURFACES,
    promptSearchPanel,
    renderProbe,
    referralPanel,
    answerModal,
    highlight,
    metricsPanel,
    historyPanel,
    citationPanel,
    assetCard,
    loadAiSide,
    loadCitations,
    bindAI,
    relTime,
  };
})();
