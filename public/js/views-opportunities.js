/* ==========================================================================
   Competitors — Negative Mentions — Opportunities

   Two halves, and the split is the point:

     LEFT   what somebody said about a competitor, and the opening it creates
     RIGHT  what was said about us in the window, in the digest shape

   THE ONE RULE THIS VIEW ENFORCES VISUALLY
   ----------------------------------------
   Evidence and advice never share a style. Anything fetched — a quote, an
   author, a date, a link — renders in the normal body treatment. Anything
   proposed — a reply angle, an asset title — renders inside the `op-play`
   block, which is visually separated and labelled "suggested". A reader
   skim-reading this at 9am must not be able to mistake a blog post we ought to
   write for one that exists.

   Nothing here fabricates. Every bullet is a verbatim sentence chosen from the
   source text by collectors/lib/signals.js; every quote is the sentence that
   triggered the classification. Where a source could not be queried, the view
   says so rather than rendering a zero.
   ========================================================================== */

(function () {
  const CHANNEL_LABEL = {
    linkedin: "LinkedIn", x: "X", web: "Web", blog: "Blog",
    video: "YouTube", event: "Event", instagram: "Instagram", facebook: "Facebook",
  };

  const THEME_LABEL = {
    pricing: "Pricing", support: "Support", reliability: "Reliability",
    outage_or_breakage: "Outage", data_loss: "Data loss", churn: "Churn",
    missing_capability: "Capability gap", usability: "Usability",
    performance: "Performance", asking_for_alternative: "Asking for an alternative",
    detractor: "Detractor", dissatisfaction: "Dissatisfaction",
    classified_without_theme: "Classified, no theme recorded",
  };

  /**
   * Relative age.
   *
   * Hours are only shown where the record carries a real timestamp. A record
   * dated from a day-precision `first_seen` renders in days, because "22h" off
   * a date with no time in it would be a precision we do not have.
   */
  function rel(iso, daysAgo) {
    if (!iso) return daysAgo != null ? daysAgo + "d" : "undated";
    const hasTime = /T\d{2}:/.test(String(iso));
    const ms = Date.now() - Date.parse(iso);
    if (!Number.isFinite(ms)) return daysAgo != null ? daysAgo + "d" : "undated";
    const h = Math.round(ms / 36e5);
    if (hasTime && h < 48) return Math.max(1, h) + "h";
    const d = Math.max(0, Math.round(ms / 864e5));
    return d === 0 ? "today" : d + "d";
  }

  function shortDate(iso) {
    if (!iso) return "";
    const d = new Date(iso);
    return isNaN(d) ? "" : d.toLocaleDateString("en-US", { day: "numeric", month: "short" });
  }

  /* ------------------------------------------------------------- the view */

  function view(ctx) {
    const { esc } = ctx;
    const O = window.__d360_opps;

    if (!O) {
      return `<h1 class="vh">Competitors — Negative Mentions — Opportunities</h1>
        <div class="empty big"><h3>Loading…</h3>
        <p>Scanning the built evidence store for negative mentions of the six tracked competitors.</p></div>`;
    }
    if (O.status === "no_data") {
      return `<h1 class="vh">Competitors — Negative Mentions — Opportunities</h1>
        <div class="empty big"><h3>No data built yet</h3><p>${esc(O.message || "")}</p></div>`;
    }

    const t = O.totals || {};
    const negs = O.competitor_negatives || [];
    const ours = O.our_mentions || [];

    return `
    <div class="mv-head">
      <h1 class="vh">Competitors — Negative Mentions — Opportunities</h1>
      <p class="vsub">Every negative mention of a tracked competitor, with the sentence that made it
      negative and what we can do about it. Plus Document360's own mentions for the chosen window.</p>
    </div>

    ${refreshBar(ctx, O)}

    <div class="istrip">
      <span><b>${t.competitor_negatives || 0}</b> competitor negatives</span>
      <span class="${t.high_priority ? "amber" : ""}"><b>${t.high_priority || 0}</b> high priority</span>
      <span><b>${t.our_mentions_in_window || 0}</b> Document360 mentions <em>(last ${O.window_days}d)</em></span>
      ${Object.entries(t.by_competitor || {}).map(([k, v]) =>
        `<span><b>${v}</b> ${esc(nameOf(ctx, k))}</span>`).join("")}
    </div>

    <div class="cav info" style="margin-bottom:14px">
      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"/><path d="M12 16v-4M12 8h.01"/></svg>
      <span>${esc(O.method || "")} ${esc(O.coverage_note || "")}</span>
    </div>

    <div class="op-cols">
      <section class="op-col">
        <div class="panel-h"><h2>Competitor negatives</h2>
          <span class="hint">${negs.length} with a quotable complaint</span></div>
        ${negs.length
          ? negs.map(n => negCard(n, ctx)).join("")
          : `<div class="empty"><p>No negative mentions of a competitor are currently classified.</p>
             <p class="sub">That is what the connected sources returned and the lexicon could anchor to a
             sentence naming the product — not a claim that none exist. Run a live sweep from the
             Mentions tab to widen the window.</p></div>`}
      </section>

      <section class="op-col">
        <div class="panel-h"><h2>Document360 mentions</h2>
          <span class="hint">${ours.length} in the last ${O.window_days} days · ${esc(shortDate(O.computed_at))}</span></div>
        ${ours.length
          ? ours.map(m => ourCard(m, ctx)).join("")
          : `<div class="empty"><p>No Document360 mentions in this window.</p>
             <p class="sub">Widen the window above, or run a live sweep from the Mentions tab.</p></div>`}
      </section>
    </div>`;
  }

  function nameOf(ctx, id) {
    const b = ctx.DATA && ctx.DATA.brands && ctx.DATA.brands[id];
    return b ? b.name : id;
  }

  /* ------------------------------------------------------ competitor card */

  function negCard(n, ctx) {
    const { esc } = ctx;
    const chan = CHANNEL_LABEL[n.channel] || n.channel;
    const theme = THEME_LABEL[n.theme] || n.theme;

    return `<article class="card op-card">
      <div class="op-head">
        <span class="op-prio p-${esc(n.priority || "LOW")}">${esc(n.priority || "LOW")}</span>
        <span class="op-sep">·</span><span class="op-comp">${esc(n.competitor_name)}</span>
        <span class="op-sep">·</span><span>${esc(chan)}</span>
        ${n.author ? `<span class="op-sep">·</span><span>${esc(n.author)}</span>` : ""}
        <span class="op-sep">·</span><span title="${esc(n.date_basis === "discovered" ? "No publication date on the page — dated from when our collector first saw it" : "Published date proven from the source")}">${esc(rel(n.date, n.days_ago))}</span>
        <span class="op-spacer"></span>
        <span class="chip ${n.theme === "classified_without_theme" ? "nc" : "bad"}">${esc(theme)}</span>
      </div>

      ${n.quote
        ? `<blockquote class="op-quote">${esc(n.quote)}</blockquote>
           ${n.matched_phrase ? `<p class="op-basis">Classified negative on the phrase “<b>${esc(n.matched_phrase)}</b>”, found in that sentence.</p>` : ""}`
        : n.rationale
          ? `<p class="op-basis"><b>Model rationale:</b> ${esc(n.rationale)}
             <em>— this record was classified by Claude and carries a rationale rather than a quoted phrase.</em></p>`
          : ""}

      ${(n.brief || []).length > 1 ? `
        <ul class="op-brief">${n.brief.map(b => `<li>${esc(b.text)}</li>`).join("")}</ul>` : ""}

      ${n.play ? `
        <div class="op-play">
          <div class="op-play-h">Suggested response <em>— not an observation; nothing below exists yet</em></div>
          <p class="op-play-angle"><b>${esc(n.play.angle)}</b></p>
          <p class="op-play-reply">${esc(n.play.channel_reply)}</p>
          <div class="op-asset">
            <span class="pm-tag">${esc(n.play.asset.kind)}</span>
            <b>${esc(n.play.asset.title)}</b>
            ${n.play.asset.proof_needed ? `<span class="op-proof">Needs first: ${esc(n.play.asset.proof_needed)}</span>` : ""}
          </div>
        </div>` : ""}

      <div class="op-foot">
        <span class="chip src" title="How this record was verified">${esc(n.verification_status || "verified")}</span>
        ${n.sentiment_grade ? `<span class="chip src" title="Which system classified it">${esc(n.sentiment_grade)}</span>` : ""}
        ${(n.priority_factors || []).length ? `<span class="op-factors" title="What produced the priority band">${esc(n.priority_factors.join(" · "))}</span>` : ""}
        <span class="op-spacer"></span>
        <a href="${esc(n.url)}" target="_blank" rel="noopener noreferrer">Open ${esc((CHANNEL_LABEL[n.channel] || "source").toLowerCase())}</a>
      </div>
    </article>`;
  }

  /* ------------------------------------------------------------- our card */

  /**
   * The digest shape:
   *
   *   HIGH · LinkedIn · Abhishek Sharma · 22h
   *     - bullet
   *     - bullet
   *     Do: ...
   *     Open post
   */
  function ourCard(m, ctx) {
    const { esc } = ctx;
    const chan = CHANNEL_LABEL[m.channel] || m.channel;

    return `<article class="card op-card ours">
      <div class="op-head">
        <span class="op-prio p-${esc(m.priority || "LOW")}">${esc(m.priority || "LOW")}</span>
        <span class="op-sep">·</span><span>${esc(chan)}</span>
        ${m.author ? `<span class="op-sep">·</span><span>${esc(m.author)}</span>` : ""}
        <span class="op-sep">·</span><span title="${esc(m.date_basis === "discovered" ? "No publication date on the page — dated from when our collector first saw it" : "Published date proven from the source")}">${esc(rel(m.date, m.days_ago))}</span>
        <span class="op-spacer"></span>
        ${m.sentiment
          ? `<span class="pm-sent s-${esc(m.sentiment)}">${esc(m.sentiment)}</span>`
          : `<span class="pm-sent s-unclassified" title="Not classified — deliberately not counted as neutral">unclassified</span>`}
      </div>

      ${(m.brief || []).length
        ? `<ul class="op-brief">${m.brief.map(b => `<li title="${esc(b.why)}">${esc(b.text)}</li>`).join("")}</ul>`
        : `<p class="op-basis">No summary could be extracted — the source text is too short to split into sentences.</p>`}

      ${m.action ? `
        <p class="op-do"><b>Do:</b> ${esc(m.action.text)}
          <em title="What in the text prompted this">(${esc(m.action.basis)})</em></p>` : ""}

      <div class="op-foot">
        <span class="chip src">${esc(m.domain || "source")}</span>
        <span class="chip src">${esc(m.verification_status || "verified")}</span>
        <span class="op-spacer"></span>
        <a href="${esc(m.url)}" target="_blank" rel="noopener noreferrer">Open ${esc((CHANNEL_LABEL[m.channel] || "source").toLowerCase() === "linkedin" ? "post" : "source")}</a>
      </div>
    </article>`;
  }

  /* ---------------------------------------------------------- refresh bar */

  function refreshBar(ctx, O) {
    const { esc } = ctx;
    const d = (O && O.window_days) || 7;
    return `
    <div class="card panel refresher" style="margin-bottom:14px">
      <div class="refresh-row">
        <div class="refresh-txt">
          <b>Scan the web and social for competitor complaints</b>
          <span>Runs the same live sweep as the Mentions tab across all six competitors, then re-reads the
          negatives. The window below bounds Document360's own mentions; a competitor complaint from three
          weeks ago is still an open opportunity, so those are not time-boxed.</span>
        </div>
        <label class="refresh-kw">
          our mentions
          <select class="control" id="oppWindow">
            ${[7, 14, 30, 90].map(n => `<option value="${n}"${n === d ? " selected" : ""}>last ${n} days</option>`).join("")}
          </select>
        </label>
        <button class="login-btn refresh-go" id="oppRefresh">Refresh</button>
      </div>
      <div class="login-msg" id="oppMsg" style="margin-top:10px"></div>
      <pre class="refresh-log" id="oppLog" hidden></pre>
    </div>`;
  }

  /* ------------------------------------------------------------------ io */

  async function load(days) {
    const d = days || 7;
    const r = await fetch("/api/opportunities?days=" + encodeURIComponent(d));
    window.__d360_opps = await r.json();
    return window.__d360_opps;
  }

  function bind(ctx) {
    const sel = document.getElementById("oppWindow");
    const btn = document.getElementById("oppRefresh");
    const msg = document.getElementById("oppMsg");
    const logBox = document.getElementById("oppLog");
    const say = (t, k) => { if (msg) { msg.textContent = t; msg.className = "login-msg " + (k || ""); } };

    if (sel) {
      sel.onchange = async () => {
        // A window change is a re-read, not a sweep: no network cost beyond
        // one JSON fetch, so it should feel instant.
        await load(parseInt(sel.value, 10));
        ctx.render();
      };
    }

    if (!btn) return;
    btn.onclick = async () => {
      btn.disabled = true;
      btn.textContent = "Scanning…";
      say("Sweeping every live source for all seven products. Free sources are rate-limited, so this takes a few minutes — it is a real scan, not a cache read.");
      if (logBox) logBox.hidden = true;

      try {
        const days = parseInt((sel || {}).value || "7", 10);
        const r = await fetch("/api/mentions/refresh", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          // No brand filter: this view is about all six competitors plus us.
          body: JSON.stringify({ days, brands: null, channels: null }),
        });
        const j = await r.json();
        if (logBox && (j.log || []).length) { logBox.textContent = j.log.join("\n"); logBox.hidden = false; }
        if (!j.ok) { say(j.error || "The scan failed. The log is below.", "err"); return; }

        const gapNote = (j.gaps || []).length
          ? ` ${j.gaps.length} source(s) could not be queried — see the log.`
          : "";
        say(`${j.candidates_found} candidate(s), ${j.records_verified} verified, ${j.added_to_store} new in ${j.duration_seconds}s.${gapNote} Re-reading…`, "ok");

        // Both payloads: the mention store changed, so the whole dashboard did.
        const data = await (await fetch("/api/data")).json();
        if (!data.error) ctx.DATA = data;
        await load(days);
        ctx.render();
      } catch (e) {
        say("Request failed: " + e.message, "err");
      } finally {
        const b = document.getElementById("oppRefresh");
        if (b) { b.disabled = false; b.textContent = "Refresh"; }
      }
    };
  }

  window.D360Opportunities = { view, bind, load };
})();
