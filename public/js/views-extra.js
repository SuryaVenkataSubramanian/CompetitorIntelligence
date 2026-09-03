/* ==========================================================================
   Two additional views, kept out of app.js so its state/filter/routing logic
   stays readable:

     New Competitors — keyword-discovered market entrants
     Settings        — webhook notifications + session

   Both follow the existing card/chip system and colour tokens; nothing here
   introduces new visual language.
   ========================================================================== */

(function () {
  /* ------------------------------------------------------ New Competitors */

  /** Competitive classification: label, chip class and display order. */
  const CLASSES = {
    direct_competitor: { label: "Direct competitor", chip: "bad", order: 0 },
    emerging_competitor: { label: "Emerging competitor", chip: "warn", order: 1 },
    adjacent_competitor: { label: "Adjacent competitor", chip: "nc", order: 2 },
    not_a_competitor: { label: "Not a competitor", chip: "zero", order: 3 },
    unclassified: { label: "Unclassified", chip: "nc", order: 4 },
  };
  const classOf = e => CLASSES[e.classification || "unclassified"] || CLASSES.unclassified;

  function viewCompetitors(ctx) {
    const { esc, DATA, fmtDate, fmtDateTime } = ctx;
    const c = DATA.competitors || {};
    const list = c.competitors || [];

    if (c.status !== "scanned") {
      return `<h1 class="vh">New Competitors</h1>
      ${refreshBar(c, ctx)}
      <div class="empty big">
        <h3>No discovery scan has run yet</h3>
        <p>${esc(c.reason || "The market keyword sweep has not been run.")}</p>
        <p class="sub">Press <b>Refresh</b> above, or run <code>npm run discover</code>. It walks a
        ${esc(String(c.keywords_total || 233))}-term market taxonomy, fetches each candidate's own homepage,
        and records only pages that are genuinely a product site — never a listicle, and never the products
        already tracked.</p>
      </div>`;
    }

    // Group by competitive classification rather than by keyword category: the
    // first question a reader has is "is this a real competitor", not "which
    // search term found it".
    const byClass = {};
    for (const e of list) {
      const k = e.classification || "unclassified";
      (byClass[k] = byClass[k] || []).push(e);
    }
    for (const k of Object.keys(byClass)) {
      byClass[k].sort((a, b) => (b.threat_score || 0) - (a.threat_score || 0));
    }

    const scored = list.filter(e => e.threat_score != null);
    const highThreat = scored.filter(e => e.threat_score >= 70).length;
    const unassessed = list.length - scored.length;
    const sweepPct = c.keywords_total ? Math.round((c.cursor_index / c.keywords_total) * 100) : 0;

    return `
    <div class="mv-head">
      <h1 class="vh">New Competitors</h1>
      <p class="vsub">${list.length} market entrant(s) found by keyword discovery, excluding the 7 tracked
      products and 92 known incumbents. Every entry is a homepage we fetched — the name, description and
      every threat signal are the product's own words.</p>
    </div>

    ${refreshBar(c, ctx)}

    <div class="istrip">
      <span><b>${list.length}</b> entrants tracked</span>
      <span class="${highThreat ? "amber" : ""}"><b>${highThreat}</b> high threat <em>(70+)</em></span>
      <span><b>${(byClass.direct_competitor || []).length}</b> direct</span>
      <span><b>${(byClass.emerging_competitor || []).length}</b> emerging</span>
      <span>keyword sweep <b>${c.cursor_index || 0}/${c.keywords_total || 0}</b> <em>(${sweepPct}%, ${c.sweeps_completed || 0} full sweep(s))</em></span>
      <span>last scan <b>${c.scanned_at ? fmtDateTime(c.scanned_at) : "—"}</b></span>
      <span class="${(c.rejected_this_run || []).length ? "amber" : ""}"><b>${(c.rejected_this_run || []).length}</b> rejected last run</span>
    </div>

    <div class="cav info" style="margin-bottom:14px">
      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"/><path d="M12 16v-4M12 8h.01"/></svg>
      <span>${esc(c.method || "")}</span>
    </div>

    ${unassessed ? `
    <div class="cav warn" style="margin-bottom:14px">
      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"/><path d="M12 16v-4M12 8h.01"/></svg>
      <span><b>${unassessed}</b> entrant(s) were found before threat scoring existed and show
      <b>no score</b> rather than a zero — a missing assessment is not a low threat. Press
      <b>Refresh</b> to re-examine them.</span>
    </div>` : ""}

    ${Object.entries(byClass)
      .sort((a, b) => classOf({ classification: a[0] }).order - classOf({ classification: b[0] }).order)
      .map(([cls, items]) => `
      <div class="comp-cat">
        <div class="comp-cat-h">
          <span class="chip ${CLASSES[cls] ? CLASSES[cls].chip : "nc"}">${esc(CLASSES[cls] ? CLASSES[cls].label : cls)}</span>
          <span class="pc">${items.length}</span>
        </div>
        <div class="comp-grid">
          ${items.map(e => competitorCard(e, ctx)).join("")}
        </div>
      </div>`).join("")}

    ${directorySection(ctx)}

    ${(c.rejected_this_run || []).length ? `
    <div class="card panel" style="margin-top:16px">
      <div class="panel-h"><h2>Rejected candidates</h2><span class="hint">why each was not counted as an entrant</span></div>
      <div class="tbl-scroll" style="max-height:260px"><table class="ptable">
        <thead><tr><th>Domain</th><th>Reason</th></tr></thead>
        <tbody>${c.rejected_this_run.slice(0, 60).map(r =>
          `<tr><td><code>${esc(r.host)}</code></td><td>${esc(r.reason)}</td></tr>`).join("")}</tbody>
      </table></div>
      <p class="chart-note">Kept visible so the exclusion is auditable rather than invisible.</p>
    </div>` : ""}`;
  }

  /**
   * The review-directory audit, rendered as its own section below web
   * discovery. Delegated to views-directories.js so this file stays about
   * web-discovered entrants.
   */
  function directorySection(ctx) {
    if (!window.D360Directories) return "";
    try { return window.D360Directories.view(ctx); }
    catch (e) {
      // A failure here must not blank the whole New Competitors tab.
      console.error("directory section failed:", e);
      return `<div class="cav warn" style="margin-top:16px">
        <span>The review-directory section failed to render: <code>${String(e.message || e)}</code>.
        This is a bug in the dashboard, not missing data.</span></div>`;
    }
  }

  /** Live-refresh control. Runs the same collector the CLI and daily job use. */
  function refreshBar(c, ctx) {
    const { esc, fmtDateTime } = ctx;
    return `
    <div class="card panel refresher" style="margin-bottom:14px">
      <div class="refresh-row">
        <div class="refresh-txt">
          <b>Live discovery</b>
          <span>Searches the web for products launched, funded or opened to beta recently, fetches each
          candidate's homepage, and scores it. Takes a few minutes — it is a real sweep, not a cache read.</span>
        </div>
        <label class="refresh-kw">
          keywords
          <select class="control" id="cmpKeywords">
            <option value="8">8 (fast)</option>
            <option value="16" selected>16</option>
            <option value="24">24</option>
            <option value="40">40 (deep)</option>
          </select>
        </label>
        <button class="login-btn refresh-go" id="cmpRefresh">Refresh</button>
      </div>
      <div class="login-msg" id="cmpMsg" style="margin-top:10px"></div>
      <pre class="refresh-log" id="cmpLog" hidden></pre>
    </div>`;
  }

  function threatMeter(score, band) {
    if (score == null) {
      return `<div class="thr">
        <div class="thr-n na">—</div>
        <div class="thr-l">not assessed</div>
      </div>`;
    }
    return `<div class="thr b-${esc(band || "low")}">
      <div class="thr-n">${score}</div>
      <div class="thr-l">threat</div>
      <div class="thr-bar"><i style="width:${score}%"></i></div>
    </div>`;
  }

  function competitorCard(e, ctx) {
    const { esc, fmtDate } = ctx;
    const conf = Math.round((e.confidence || 0) * 100);
    const aconf = e.assessment_confidence != null ? Math.round(e.assessment_confidence * 100) : null;
    const cls = classOf(e);

    return `<article class="card comp">
      <div class="comp-head">
        <span class="comp-fav">${esc(String(e.name || "?").charAt(0).toUpperCase())}</span>
        <div class="comp-id">
          <h3><a href="${esc(e.website)}" target="_blank" rel="noopener noreferrer">${esc(e.name)}</a></h3>
          <span class="comp-dom">${esc(e.domain)}${
            e.company && !e.company_same_as_product ? ` · ${esc(e.company)}` : ""}</span>
        </div>
        ${threatMeter(e.threat_score, e.threat_band)}
      </div>

      <p class="comp-desc">${esc(e.description || "No description published on the site.")}</p>

      <div class="comp-class">
        <span class="chip ${cls.chip}">${esc(cls.label)}</span>
        ${(e.categories || []).slice(0, 1).map(x => `<span class="pm-tag">${esc(x)}</span>`).join("")}
      </div>

      ${e.why_it_could_compete ? `
        <p class="comp-why"><b>Why it could compete:</b> ${esc(e.why_it_could_compete)}</p>` : ""}

      ${e.classification_basis ? `
        <p class="comp-basis">${esc(e.classification_basis)}</p>` : ""}

      ${(e.threat_signals || []).length ? `
        <details class="comp-sig">
          <summary>Threat signals (${e.threat_signals.length})</summary>
          <table class="ptable"><tbody>
            ${e.threat_signals.map(s => `<tr>
              <td>${esc(s.label)}</td>
              <td class="tnum">+${s.contributed}<span class="muted">/${s.of_max}</span></td>
              <td class="muted" style="font-size:11px">${(s.evidence || []).slice(0, 2).map(x =>
                `“${esc(x.matched)}” <em>${esc(x.where)}</em>`).join("; ")}</td>
            </tr>`).join("")}
          </tbody></table>
          <p class="chart-note" style="margin:6px 0 0">Scored only on what the product publishes about
          itself — never on the search keyword that surfaced it.</p>
        </details>` : ""}

      <div class="comp-meta">
        ${e.launch_date
          ? `<span title="${esc(e.launch_date_basis || "")}">launched ${esc(String(e.launch_date).slice(0, 10))}</span>`
          : `<span class="muted" title="No launch date is published on the site. The discovery date is not a substitute for it.">launch date not published</span>`}
        ${e.first_seen ? `<span class="sep">·</span><span title="First time our discovery run saw this product">discovered ${esc(fmtDate(String(e.first_seen).slice(0, 10)))}</span>` : ""}
        ${e.times_seen > 1 ? `<span class="sep">·</span><span>seen in ${e.times_seen} scans</span>` : ""}
      </div>

      <div class="comp-foot">
        <span class="pm-tag" title="Confidence that this is a genuine new entrant: does its own page place it in this category, how many keywords surfaced it, how many product signals its homepage shows.">${conf}% entrant</span>
        ${aconf != null ? `<span class="pm-tag" title="Confidence in the classification and threat score, driven by how much of the judgement came from the product's own title and description rather than incidental page text.">${aconf}% assessment</span>` : ""}
        <span class="pm-spacer"></span>
        <a class="comp-visit" href="${esc(e.evidence_url || e.website)}" target="_blank" rel="noopener noreferrer">
          Evidence
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M15 3h6v6M10 14 21 3"/><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/></svg>
        </a>
      </div>
    </article>`;
  }

  /** Wire the Refresh button. */
  function bindCompetitors(ctx) {
    // The directory audit's own control lives in the same view.
    if (window.D360Directories) {
      try { window.D360Directories.bind(ctx); } catch (e) { console.error("directory bind failed:", e); }
    }

    const btn = document.getElementById("cmpRefresh");
    const msg = document.getElementById("cmpMsg");
    const logBox = document.getElementById("cmpLog");
    const show = (t, k) => { if (msg) { msg.textContent = t; msg.className = "login-msg " + (k || ""); } };
    if (!btn) return;

    btn.onclick = async () => {
      const kw = parseInt((document.getElementById("cmpKeywords") || {}).value || "16", 10);
      btn.disabled = true;
      btn.textContent = "Sweeping…";
      show(`Running a live discovery sweep over ${kw} keywords. This takes a few minutes — each candidate's homepage is fetched and scored.`);
      if (logBox) logBox.hidden = true;
      try {
        const r = await fetch("/api/competitors/refresh", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ keywords: kw, recent: true }),
        });
        const j = await r.json();
        if (logBox && (j.log || []).length) {
          logBox.textContent = j.log.join("\n");
          logBox.hidden = false;
        }
        if (j.timed_out) {
          show("The sweep is taking longer than 8 minutes. It is still running in the background — reload this tab shortly to see the result.", "err");
          return;
        }
        if (!j.ok) { show("The sweep failed. The collector log is below.", "err"); return; }

        show(`Sweep complete: ${j.new_this_run || 0} new entrant(s), ${j.total} tracked in total, ${j.rejected} candidate(s) rejected.`, "ok");
        // Re-pull the competitor payload and re-render with the new data.
        const d = await (await fetch("/api/competitors")).json();
        ctx.DATA.competitors = d;
        ctx.render();
      } catch (e) {
        show("Request failed: " + e.message, "err");
      } finally {
        btn.disabled = false;
        btn.textContent = "Refresh";
      }
    };
  }

  /* ---------------------------------------------------------------- Settings */

  function viewSettings(ctx) {
    const { esc, DATA } = ctx;
    const w = (window.__d360_webhook) || null;

    return `
    <div class="mv-head">
      <h1 class="vh">Settings</h1>
      <p class="vsub">Notification webhook and session. API credentials live server-side in <code>.env</code>
      and are never sent to the browser.</p>
    </div>

    <div class="grid2">
      <div class="card panel">
        <div class="panel-h">
          <h2>Notification webhook</h2>
          <span class="chip ${w && w.enabled ? "ok" : "nc"}" id="whStatus">${w && w.enabled ? "enabled" : "not configured"}</span>
        </div>

        <p class="chart-note" style="margin-top:0">
          Posts a signed JSON payload when new mentions land. Saving verifies the endpoint with a live test
          delivery — the webhook is only marked enabled if that test actually succeeds, so "enabled" always
          means "proven reachable".
        </p>

        <label class="lf" style="margin-top:14px">
          <span>Webhook URL</span>
          <input type="url" id="whUrl" placeholder="https://hooks.example.com/d360"
                 value="${esc((w && w.url) || "")}" spellcheck="false" />
        </label>

        <div class="ev-h">Events</div>
        <div class="capgrid" id="whEvents">
          ${["new_mentions", "negative_mention", "buying_intent", "new_competitor"].map(ev => {
            const on = !w || !w.events || !w.events.length || w.events.includes(ev);
            return `<label class="cap ${on ? "yes" : ""}" style="cursor:pointer">
              <input type="checkbox" data-wh-event="${ev}" ${on ? "checked" : ""} style="margin-right:6px" />
              ${esc(ev.replace(/_/g, " "))}
            </label>`;
          }).join("")}
        </div>

        <div style="display:flex;gap:8px;margin-top:16px;flex-wrap:wrap">
          <button class="login-btn" style="width:auto;padding:0 18px;height:38px;margin:0" id="whSave">Save &amp; verify</button>
          <button class="pill" id="whTest" ${w && w.enabled ? "" : "disabled"}>Send test</button>
          ${w && w.enabled ? `<button class="pill" id="whDisable">Disable</button>` : ""}
        </div>

        <div class="login-msg" id="whMsg" style="margin-top:12px"></div>

        ${w && w.secret_hint ? `<p class="chart-note"><b>Signing secret:</b> <code>${esc(w.secret_hint)}</code> —
          verify <code>X-D360-Signature</code> as <code>sha256=HMAC-SHA256(secret, raw body)</code>.
          The full secret is shown once when it is generated.</p>` : ""}

        ${w && (w.recent || []).length ? `
          <div class="ev-h" style="margin-top:16px">Recent deliveries</div>
          <table class="ptable"><tbody>
            ${w.recent.slice(0, 6).map(d => `<tr>
              <td>${esc(d.event)}</td>
              <td class="muted" style="font-size:11px">${esc(String(d.at).replace("T", " ").slice(0, 19))}</td>
              <td style="text-align:right"><span class="chip ${d.ok ? "ok" : "bad"}">${d.ok ? "delivered" : "failed " + (d.status || "")}</span></td>
            </tr>`).join("")}
          </tbody></table>` : ""}
      </div>

      ${digestPanel(esc)}

      <div class="card panel">
        <div class="panel-h"><h2>Session</h2></div>
        <table class="ptable"><tbody>
          <tr><td>Signed in as</td><td style="text-align:right"><b id="meEmail">…</b></td></tr>
          <tr><td>Access</td><td style="text-align:right">4 allow-listed accounts</td></tr>
        </tbody></table>
        <p class="chart-note">
          Passwords are stored only as scrypt hashes with a per-user salt. Sessions are opaque server-side
          tokens in an HttpOnly cookie, so signing out genuinely revokes access rather than only clearing
          the browser.
        </p>
        <button class="pill" id="logoutBtn" style="margin-top:12px">Sign out</button>
      </div>
    </div>`;
  }

  /* ------------------------------------------------- daily competitor digest */

  /**
   * Daily digest status. Deliberately explicit about the difference between
   * "generated" and "delivered": with no SMTP credentials the digest is still
   * produced and stored, and saying so is more useful than an empty panel or a
   * false "sent" claim.
   */
  function digestPanel(esc) {
    const d = window.__d360_digest || null;
    const latest = d && d.latest;
    const email = (d && d.email) || null;
    const bd = (d && d.brightdata) || null;

    const mailChip = !email ? "nc" : email.configured ? "ok" : "warn";
    const mailText = !email ? "unknown" : email.configured ? "configured" : "not configured";

    return `
    <div class="card panel">
      <div class="panel-h">
        <h2>Daily new-competitor digest</h2>
        <span class="chip ${mailChip}">email ${mailText}</span>
      </div>

      <p class="chart-note" style="margin-top:0">
        Runs a recent-launch discovery sweep, diffs it against everything already reported, and summarises
        only what is new or has materially changed. A product it has already told you about is not repeated —
        that is what keeps a daily email readable.
      </p>

      ${latest ? `
        <div class="dg-row"><b>${esc(latest.date)}</b>
          <span>${latest.new_count} new · ${latest.changed_count} changed · ${latest.high_threat_count} high threat</span>
          <span class="muted">${latest.unchanged_count} unchanged, not re-listed</span></div>
        <div class="dg-row">delivery
          <span>${latest.delivery && latest.delivery.delivered
            ? `<span class="chip ok">delivered to ${esc(latest.delivery.to || "")}</span>`
            : `<span class="chip warn">generated, not delivered</span>`}</span></div>
        ${latest.rendered_text ? `<pre class="dg-pre">${esc(latest.rendered_text)}</pre>` : ""}
      ` : `
        <div class="empty mini" style="margin-top:12px">
          <p>No digest has been generated yet.</p>
          <p class="sub">Run <code>npm run digest</code> for one pass now, or
          <code>npm run digest:schedule</code> to keep it running daily.</p>
        </div>`}

      ${email && !email.configured ? `
        <p class="ais-enable" style="margin-top:12px">
          <b>To enable email delivery</b>, add <code>${esc((email.missing || []).join(", "))}</code> to
          <code>.env</code>. ${esc(email.requirement || "")}
        </p>` : ""}

      ${email && email.configured ? `
        <p class="chart-note">Sending to <b>${esc(email.to)}</b> via ${esc(email.host)}:${email.port}
        as ${esc(email.user_hint || "")}. Credentials stay server-side.</p>` : ""}

      ${bd && bd.request_api && !bd.request_api.available ? `
        <p class="ais-enable" style="margin-top:12px">
          <b>Bright Data SERP/Unlocker zone:</b> ${esc(bd.request_api.reason || "")}
        </p>` : ""}

      <div style="display:flex;gap:8px;margin-top:14px;flex-wrap:wrap">
        <button class="pill" id="dgRun">Run digest now</button>
      </div>
      <div class="login-msg" id="dgMsg" style="margin-top:10px"></div>
    </div>`;
  }

  async function loadDigest() {
    try {
      const r = await fetch("/api/digest");
      window.__d360_digest = r.ok ? await r.json() : null;
    } catch (e) { window.__d360_digest = null; }
  }

  /* --------------------------------------------------------------- wiring */

  async function loadWebhook() {
    try {
      const r = await fetch("/api/webhook");
      window.__d360_webhook = await r.json();
    } catch (e) {
      window.__d360_webhook = null;
    }
  }

  function bindSettings(ctx) {
    const msg = document.getElementById("whMsg");
    const show = (t, k) => { if (msg) { msg.textContent = t; msg.className = "login-msg " + (k || ""); } };

    const save = document.getElementById("whSave");
    if (save) {
      save.onclick = async () => {
        const url = (document.getElementById("whUrl") || {}).value || "";
        const events = [...document.querySelectorAll("[data-wh-event]")]
          .filter(x => x.checked).map(x => x.dataset.whEvent);
        save.disabled = true;
        show("Saving and sending a test delivery…");
        try {
          const r = await fetch("/api/webhook", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ url, events, enabled: true }),
          });
          const j = await r.json();
          if (j.ok) {
            let t = "Verified and enabled — the test delivery succeeded.";
            if (j.secret) t += `  Signing secret (shown once): ${j.secret}`;
            if (j.warning) t += `  Note: ${j.warning}`;
            show(t, "ok");
            await loadWebhook();
            ctx.render();
          } else {
            show(j.error || "Could not save the webhook.", "err");
          }
        } catch (e) {
          show("Request failed: " + e.message, "err");
        } finally {
          save.disabled = false;
        }
      };
    }

    const test = document.getElementById("whTest");
    if (test) {
      test.onclick = async () => {
        test.disabled = true;
        show("Sending test delivery…");
        try {
          const r = await fetch("/api/webhook/test", { method: "POST" });
          const j = await r.json();
          show(j.ok ? `Test delivered (HTTP ${j.status}).` : `Test failed: ${j.error || j.status || "unknown"}`, j.ok ? "ok" : "err");
          await loadWebhook();
        } catch (e) {
          show("Request failed: " + e.message, "err");
        } finally {
          test.disabled = false;
        }
      };
    }

    const dis = document.getElementById("whDisable");
    if (dis) {
      dis.onclick = async () => {
        await fetch("/api/webhook", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ enabled: false }),
        });
        await loadWebhook();
        ctx.render();
      };
    }

    /* -------------------------------------------------------- daily digest */
    const dg = document.getElementById("dgRun");
    const dgMsg = document.getElementById("dgMsg");
    const dgShow = (t, k) => { if (dgMsg) { dgMsg.textContent = t; dgMsg.className = "login-msg " + (k || ""); } };
    if (dg) {
      dg.onclick = async () => {
        dg.disabled = true;
        dg.textContent = "Running…";
        dgShow("Diffing the latest scan against everything already reported…");
        try {
          // discover:false — re-diff the stored scan rather than launching a
          // multi-minute sweep from a button click. The scheduled job does the
          // sweep; New Competitors → Refresh does it on demand.
          const r = await fetch("/api/digest/run", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ discover: false }),
          });
          const j = await r.json();
          if (!j.ok) { dgShow(j.error || "The digest run failed.", "err"); return; }
          const d = j.digest || {};
          const del = j.delivery || {};
          dgShow(
            `${d.new_count} new, ${d.changed_count} changed, ${d.unchanged_count} unchanged. ` +
            (del.delivered ? `Emailed to ${del.to}.` : "Stored but not emailed — SMTP is not configured."),
            del.delivered ? "ok" : "err"
          );
          await loadDigest();
          ctx.render();
        } catch (e) {
          dgShow("Request failed: " + e.message, "err");
        } finally {
          dg.disabled = false;
          dg.textContent = "Run digest now";
        }
      };
    }

    const logout = document.getElementById("logoutBtn");
    if (logout) {
      logout.onclick = async () => {
        await fetch("/api/logout", { method: "POST" });
        window.location.replace("/login");
      };
    }

    fetch("/api/me").then(r => r.json()).then(j => {
      const el = document.getElementById("meEmail");
      if (el) el.textContent = j.email || "unknown";
    }).catch(() => {});
  }

  window.D360Views = {
    viewCompetitors, viewSettings, loadWebhook, loadDigest,
    bindSettings, bindCompetitors,
  };
})();
