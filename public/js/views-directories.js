/* ==========================================================================
   Review-directory listings — new products across 7 directories × 6 categories.

   Rendered as a section inside New Competitors, because it answers a
   neighbouring question: web discovery finds products that EXIST, while a
   directory listing finds products that have entered a buyer's comparison set.
   The second is the one that shows up in a deal.

   Reuses the existing card / chip / table classes. No new visual language.
   ========================================================================== */

(function () {
  const esc = s => String(s == null ? "" : s).replace(/[&<>"']/g, c =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

  /** Directory display order and their brand colours. */
  const DIRS = [
    { id: "g2", label: "G2", color: "#ff492c" },
    { id: "capterra", label: "Capterra", color: "#ff9d28" },
    { id: "getapp", label: "GetApp", color: "#ff5c35" },
    { id: "trustradius", label: "TrustRadius", color: "#1a7ac7" },
    { id: "gartner", label: "Gartner", color: "#00355f" },
    { id: "softwareadvice", label: "SoftwareAdvice", color: "#f26522" },
    { id: "softwaresuggest", label: "SoftwareSuggest", color: "#2a9d5c" },
  ];
  const dirOf = id => DIRS.find(d => d.id === id) || { id, label: id, color: "var(--ink-3)" };

  const CAT_ORDER = [
    "knowledge_base", "customer_self_service", "contact_center_kb",
    "sop", "ai_doc_generator", "api_documentation",
  ];

  function view(ctx) {
    const { DATA, fmtDateTime } = ctx;
    const d = (window.__d360_directories) || null;

    if (!d || d.status !== "audited") {
      return `
      <div class="dir-sec">
        <h2 class="vh2">Review-directory listings</h2>
        ${refreshBar(null)}
        <div class="empty big">
          <h3>No directory audit has run yet</h3>
          <p>${esc((d && d.reason) || "The review directories have not been audited.")}</p>
          <p class="sub">Press <b>Audit directories</b> above, or run <code>npm run directories</code>.
          It checks G2, Capterra, GetApp, TrustRadius, Gartner, SoftwareAdvice and SoftwareSuggest
          across all six categories.</p>
        </div>
      </div>`;
    }

    const products = d.products || [];
    const news = products.filter(p => p.is_new);
    const multi = products.filter(p => (p.directories || []).length > 1);
    const conflicts = products.filter(p => p.source_conflict);

    // Group by category. A product in two categories appears under both.
    const cats = CAT_ORDER
      .map(id => ({ id, ...(d.per_category || {})[id] }))
      .filter(c => c.label);

    return `
    <div class="dir-sec">
      <h2 class="vh2">Review-directory listings</h2>
      <p class="vsub">${products.length} product(s) listed across
        ${(d.directories_audited || []).length} directories in
        ${(d.categories_audited || []).length} categories.
        A directory listing means a product has entered a buyer's comparison set — which is a
        different, later signal than a product merely existing.</p>

      ${refreshBar(d, fmtDateTime)}

      <div class="istrip">
        <span><b>${products.length}</b> listed</span>
        <span class="${news.length ? "amber" : ""}"><b>${news.length}</b> new</span>
        <span><b>${multi.length}</b> on 2+ directories</span>
        <span><b>${(d.totals || {}).excluded || 0}</b> excluded <em>(tracked / incumbent)</em></span>
        <span><b>${(d.totals || {}).category_unconfirmed || 0}</b> not category-confirmed</span>
        <span>last audit <b>${d.audited_at ? fmtDateTime(d.audited_at) : "—"}</b></span>
      </div>

      <div class="cav info" style="margin-bottom:14px">
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"/><path d="M12 16v-4M12 8h.01"/></svg>
        <span>${esc(d.method || "")}</span>
      </div>

      <div class="cav info" style="margin-bottom:14px">
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 2 2 7l10 5 10-5-10-5Z"/><path d="m2 17 10 5 10-5M2 12l10 5 10-5"/></svg>
        <span><b>How these are read:</b> ${esc(d.access_method || "")}</span>
      </div>

      ${conflicts.length ? `
      <div class="cav warn" style="margin-bottom:14px">
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0Z"/><path d="M12 9v4M12 17h.01"/></svg>
        <span><b>${conflicts.length} source conflict(s).</b> The directories place these products in a
        knowledge or documentation category, but the website resolved for them does not read as a
        competitor. The domain is matched on name similarity, so it may belong to a different company
        with the same name — <b>neither reading is asserted</b>. They are marked below.</span>
      </div>` : ""}

      <!-- Coverage per directory. A directory returning nothing is a real
           finding about that source, so it is shown rather than omitted. -->
      <div class="ev-h">Coverage by directory</div>
      <div class="tbl-scroll" style="margin-bottom:16px"><table class="ptable wide">
        <thead><tr><th>Directory</th><th>Listed</th><th>New</th>
          ${cats.map(c => `<th title="${esc(c.label)}">${esc(shortCat(c.id))}</th>`).join("")}</tr></thead>
        <tbody>${DIRS.filter(x => (d.directories_audited || []).includes(x.id)).map(x => {
          const pd = (d.per_directory || {})[x.id] || {};
          const zero = !pd.products;
          return `<tr class="${zero ? "gaprow" : ""}">
            <td><span style="color:${x.color}">●</span> ${esc(x.label)}</td>
            <td class="tnum">${pd.products ?? 0}</td>
            <td class="tnum">${pd.new ?? 0}</td>
            ${cats.map(c => `<td class="tnum">${(pd.by_category || {})[c.id] ?? 0}</td>`).join("")}
          </tr>`;
        }).join("")}</tbody>
      </table></div>
      ${DIRS.some(x => (d.directories_audited || []).includes(x.id) && !((d.per_directory || {})[x.id] || {}).products)
        ? `<p class="chart-note" style="margin-top:-10px">A directory showing zero was queried and
           returned no category-confirmed product page — most often because its result snippets carry
           no category wording for the gate to confirm against. That is a coverage limit of the source,
           not a measured absence of products.</p>` : ""}

      ${cats.map(c => {
        const items = products.filter(p => (p.categories || []).some(x => x.id === c.id))
          .sort((a, b) =>
            (b.directories.length - a.directories.length) ||
            ((b.threat_score || 0) - (a.threat_score || 0)) ||
            (b.confidence - a.confidence));
        if (!items.length) {
          return `<div class="comp-cat">
            <div class="comp-cat-h">${esc(c.label)} <span class="pc">0</span></div>
            <p class="chart-note" style="margin:0">No category-confirmed listing found for this category
            in the last audit.</p>
          </div>`;
        }
        return `<div class="comp-cat">
          <div class="comp-cat-h">${esc(c.label)} <span class="pc">${items.length}</span>
            ${items.filter(p => p.is_new).length ? `<span class="chip warn">${items.filter(p => p.is_new).length} new</span>` : ""}</div>
          <div class="comp-grid">${items.map(card).join("")}</div>
        </div>`;
      }).join("")}
    </div>`;
  }

  function shortCat(id) {
    return {
      knowledge_base: "KB", customer_self_service: "Self-svc",
      contact_center_kb: "CC KB", sop: "SOP",
      ai_doc_generator: "AI docs", api_documentation: "API docs",
    }[id] || id;
  }

  function card(p) {
    const conf = Math.round((p.confidence || 0) * 100);
    const dirCount = (p.directories || []).length;
    return `<article class="card comp dir-card${p.source_conflict ? " conflict" : ""}">
      <div class="comp-head">
        <span class="comp-fav">${esc(String(p.product || "?").charAt(0).toUpperCase())}</span>
        <div class="comp-id">
          <h3>${p.website
            ? `<a href="${esc(p.website)}" target="_blank" rel="noopener noreferrer">${esc(p.product)}</a>`
            : esc(p.product)}</h3>
          <span class="comp-dom">${p.company && p.company !== p.product ? esc(p.company) + " · " : ""}${
            p.website ? esc(String(p.website).replace(/^https?:\/\//, "").replace(/\/$/, "")) : `<span class="muted">${esc(p.website_status || "website not resolved")}</span>`}</span>
        </div>
        ${p.threat_score != null
          ? `<div class="thr b-${esc(p.threat_band || "low")}">
               <div class="thr-n">${p.threat_score}</div><div class="thr-l">threat</div>
               <div class="thr-bar"><i style="width:${p.threat_score}%"></i></div>
             </div>`
          : `<span class="chip nc" title="No vendor website was resolved, so no homepage could be assessed. This is 'not assessed', not a low threat.">not assessed</span>`}
      </div>

      ${p.description
        ? `<p class="comp-desc">${esc(p.description)}</p>`
        : p.description_note
          ? `<p class="comp-desc muted">${esc(p.description_note)}</p>`
          : ""}

      <div class="dir-badges">
        ${(p.listings || []).map(l => {
          const dd = dirOf(l.directory);
          return `<a class="dir-badge" href="${esc(l.url)}" target="_blank" rel="noopener noreferrer"
            style="--dc:${dd.color}" title="${esc(l.title || l.url)}">${esc(dd.label)}</a>`;
        }).join("")}
        ${dirCount > 1 ? `<span class="pm-tag" title="Appearing on several directories is independent corroboration that the product is genuinely being evaluated.">${dirCount} directories</span>` : ""}
      </div>

      <div class="comp-class">
        ${(p.categories || []).map(c => `<span class="pm-tag cmp" title="Confirmed by &quot;${esc(c.confirmed_by || "")}&quot; in the ${esc(c.where || "listing")}">${esc(c.label)}</span>`).join("")}
      </div>

      ${p.why_it_could_compete ? `<p class="comp-why"><b>Why it could compete:</b> ${esc(p.why_it_could_compete)}</p>` : ""}

      ${p.source_conflict ? `
        <p class="dir-conflict"><b>Sources disagree.</b> ${esc(p.source_conflict.detail)}</p>` : ""}

      <div class="comp-foot">
        <span class="pm-tag" title="${esc((p.confidence_basis || []).join(" · "))}">${conf}% confidence</span>
        ${p.is_new ? `<span class="pm-tag intent">new</span>` : ""}
        ${p.name_source && !/listing title/.test(p.name_source)
          ? `<span class="pm-tag" title="${esc(p.name_source)}">name approximate</span>` : ""}
        <span class="pm-spacer"></span>
        <a class="comp-visit" href="${esc((p.listings || [])[0] ? p.listings[0].url : "#")}" target="_blank" rel="noopener noreferrer">
          Listing
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M15 3h6v6M10 14 21 3"/><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/></svg>
        </a>
      </div>
    </article>`;
  }

  function refreshBar(d, fmtDateTime) {
    return `
    <div class="card panel refresher" style="margin-bottom:14px">
      <div class="refresh-row">
        <div class="refresh-txt">
          <b>Audit the review directories</b>
          <span>Checks all 7 directories across all 6 categories — about 126 searches, so it takes
          several minutes. Reads the public search index, which costs nothing.</span>
        </div>
        <label class="refresh-kw">
          scope
          <select class="control" id="dirScope">
            <option value="all" selected>all directories</option>
            ${DIRS.map(x => `<option value="${x.id}">${esc(x.label)} only</option>`).join("")}
          </select>
        </label>
        <button class="login-btn refresh-go" id="dirRefresh">Audit directories</button>
      </div>
      <div class="login-msg" id="dirMsg" style="margin-top:10px"></div>
      <pre class="refresh-log" id="dirLog" hidden></pre>
    </div>`;
  }

  async function load() {
    try {
      const r = await fetch("/api/directories");
      window.__d360_directories = r.ok ? await r.json() : null;
    } catch (e) { window.__d360_directories = null; }
  }

  function bind(ctx) {
    const btn = document.getElementById("dirRefresh");
    const msg = document.getElementById("dirMsg");
    const logBox = document.getElementById("dirLog");
    const show = (t, k) => { if (msg) { msg.textContent = t; msg.className = "login-msg " + (k || ""); } };
    if (!btn) return;

    btn.onclick = async () => {
      const scope = (document.getElementById("dirScope") || {}).value || "all";
      btn.disabled = true;
      btn.textContent = "Auditing…";
      show(scope === "all"
        ? "Auditing 7 directories × 6 categories. This takes several minutes — 126 searches against the public index."
        : `Auditing ${scope} across 6 categories.`);
      if (logBox) logBox.hidden = true;
      try {
        const r = await fetch("/api/directories/refresh", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(scope === "all" ? { resolve: true } : { directory: scope, resolve: true }),
        });
        const j = await r.json();
        if (logBox && (j.log || []).length) { logBox.textContent = j.log.join("\n"); logBox.hidden = false; }
        if (j.timed_out) {
          show("The audit is taking longer than 12 minutes. It is still running — reload this tab shortly.", "err");
          return;
        }
        if (!j.ok) { show("The audit failed. The collector log is below.", "err"); return; }
        const t = j.totals || {};
        show(`Audit complete: ${t.products || 0} product(s) listed, ${t.new || 0} new, ` +
          `${t.excluded || 0} excluded, ${t.category_unconfirmed || 0} not category-confirmed.`, "ok");
        await load();
        ctx.render();
      } catch (e) {
        show("Request failed: " + e.message, "err");
      } finally {
        btn.disabled = false;
        btn.textContent = "Audit directories";
      }
    };
  }

  window.D360Directories = { view, load, bind, DIRS, CAT_ORDER };
})();
