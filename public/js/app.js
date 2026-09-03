/* ==========================================================================
   Document360 — Competitive Intelligence

   Rendering rules this file obeys, because they are what make the dashboard
   usable for a business decision:

   1. A number is only shown if it was computed from verified records. Where a
      figure is a floor rather than a total, the caveat is rendered next to it —
      not buried in a footnote.
   2. Date ranges filter on verified publication dates only. Records with no
      provable date are surfaced as a separate "undated" count, never folded
      into the current range.
   3. Sentiment has FOUR states: positive, negative, neutral, unclassified.
      Unclassified is never displayed as neutral and never counted in a
      sentiment percentage.
   4. A channel with no credential renders as "not connected" with the exact
      blocker — never as zero, because zero implies "we looked and found none".
   5. Every mention exposes its evidence excerpt, its link health, and how its
      date and sentiment were derived.
   ========================================================================== */

let DATA = null;

/* ---------------------------------------------------------------- helpers */
const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];
const esc = s => String(s == null ? "" : s).replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const store = {
  g: k => { try { return localStorage.getItem(k); } catch (e) { return null; } },
  s: (k, v) => { try { localStorage.setItem(k, v); } catch (e) {} },
};
const pct = (n, d) => (d ? Math.round((n / d) * 100) : null);
const fmtDate = s => {
  if (!s) return "no date";
  const d = new Date(s + "T00:00:00Z");
  return isNaN(d) ? s : d.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
};
const fmtDateTime = s => {
  if (!s) return "—";
  const d = new Date(s);
  return isNaN(d) ? s : d.toLocaleString("en-US", { month: "short", day: "numeric", year: "numeric", hour: "numeric", minute: "2-digit" });
};

const CHANNEL_ICONS = {
  linkedin: '<path d="M4.98 3.5a2.5 2.5 0 1 1 0 5 2.5 2.5 0 0 1 0-5zM3 9h4v12H3zM10 9h3.8v1.7c.5-1 1.8-2 3.7-2 2.7 0 4.5 1.7 4.5 5.3V21h-4v-6.2c0-1.6-.6-2.6-2-2.6-1.2 0-1.9.8-2.2 1.6-.1.3-.1.7-.1 1V21h-4z"/>',
  blog: '<path d="M4 11a9 9 0 0 1 9 9M4 4a16 16 0 0 1 16 16"/><circle cx="5" cy="19" r="1.5" fill="currentColor" stroke="none"/>',
  web: '<circle cx="12" cy="12" r="9"/><path d="M3 12h18M12 3a15 15 0 0 1 0 18 15 15 0 0 1 0-18z"/>',
  video: '<rect x="3" y="5" width="18" height="14" rx="3"/><path d="M10 9l5 3-5 3z" fill="currentColor" stroke="none"/>',
  x: '<path d="M4 4l16 16M20 4L4 20"/>',
  event: '<rect x="3" y="5" width="18" height="16" rx="2"/><path d="M16 3v4M8 3v4M3 11h18M8 15h3"/>',
};
function chIcon(id, size = 15) {
  return `<svg width="${size}" height="${size}" viewBox="0 0 24 24" fill="${id === "linkedin" ? "currentColor" : "none"}" stroke="${id === "linkedin" ? "none" : "currentColor"}" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">${CHANNEL_ICONS[id] || CHANNEL_ICONS.web}</svg>`;
}
const chLabel = id => (DATA.meta.channels.find(c => c.id === id) || { label: id }).label;
const brandName = id => (DATA.brands[id] || { name: id }).name;
const favLetter = d => (d || "?").replace(/^www\./, "").charAt(0).toUpperCase();

/* ------------------------------------------------------------------ state */
/**
 * Tabs, deliberately few. The old "Overview" tab stacked KPI tiles, a
 * share-of-voice bar chart, a sentiment donut, a channel grid, a caveat banner, an
 * integrity strip and a latest-mentions list on one screen — which is what made
 * the dashboard feel complicated. Mentions is now the landing page and carries the
 * one summary that matters (the brand x channel matrix); everything else moved
 * behind a tab or was dropped.
 */
const TABS = [
  { id: "mentions", label: "Mentions" },
  { id: "competitors", label: "New Competitors" },
  { id: "ai", label: "AI Visibility" },
  { id: "recommendations", label: "Recommendations" },
  { id: "sources", label: "Data quality" },
  { id: "settings", label: "Settings" },
];
const RANGE_LABELS = { 7: "Last 7 days", 30: "Last 30 days", 90: "Last 90 days", 365: "Last 365 days", all: "All dated + undated" };

let STATE = {
  view: "mentions",
  brand: "document360",
  range: 90,
  channels: [],
  sentiments: [],
  page: 1,
  sort: "recent",
  includeDiscovered: true,   // ranges use published-else-discovered by default
  recType: "all",
  recOwner: "all",
};
const brand = () => DATA.brands[STATE.brand];

/* ------------------------------------------------------- filtering (real) */

/**
 * Range test on the EFFECTIVE date (published where proven, else the date our
 * collector first saw it). Filtering on publication date alone hid a third of the
 * dataset, because most search-discovered pages expose no machine-readable date.
 * Each row still shows which basis it used.
 */
function inRange(m) {
  const d = m.effective_days_ago;
  if (d == null) return true; // no axis at all — never silently dropped
  if (STATE.range === "all") return true;
  if (!STATE.includeDiscovered && m.date_basis === "discovered") {
    // User asked for publication dates only.
    return m.days_ago != null && m.days_ago <= STATE.range;
  }
  return d <= STATE.range;
}

/**
 * `excludeChannelFilter` exists because of a real bug: the channel-count cards
 * were computed from the same filtered set they control, so selecting "Videos"
 * made every other channel read 0 — and a 0 with a caveat note rendered as
 * "not connected". A channel's own count must never depend on the channel filter.
 */
function filtered(brandId, { excludeChannelFilter = false } = {}) {
  const b = DATA.brands[brandId || STATE.brand];
  if (!b) return [];
  let ms = (b.mentions || []).filter(inRange);
  if (STATE.channels.length && !excludeChannelFilter) {
    ms = ms.filter(m => STATE.channels.includes(m.channel));
  }
  if (STATE.sentiments.length) {
    ms = ms.filter(m => STATE.sentiments.includes(m.sentiment || "unclassified"));
  }
  ms.sort((a, c) => {
    const av = a.effective_days_ago, cv = c.effective_days_ago;
    if (av == null && cv == null) return 0;
    if (av == null) return 1;
    if (cv == null) return -1;
    return STATE.sort === "oldest" ? cv - av : av - cv;
  });
  return ms;
}

/** Counts across all 7 brands for the current range/filters — share of voice. */
function allBrandCounts() {
  return DATA.meta.brand_order.map(id => ({
    id,
    name: brandName(id),
    value: filtered(id).length,
    hi: id === STATE.brand,
  }));
}

/* ----------------------------------------------------------------- charts */
function hbars(rows, { fmt = x => x, note = null } = {}) {
  const max = Math.max(1, ...rows.map(r => r.value));
  if (!rows.length) return emptyMini("Nothing to chart in this range");
  return `<div class="bars">${rows.map(r => `<div class="bar-row">
    <span class="nm ${r.hi ? "hi" : ""}" title="${esc(r.label || r.name)}">${esc(r.label || r.name)}</span>
    <span class="track"><span class="fill ${r.hi ? "" : "mut"}" style="width:${((r.value / max) * 100).toFixed(1)}%"></span></span>
    <span class="n tnum">${fmt(r.value)}</span></div>`).join("")}</div>
    ${note ? `<p class="chart-note">${esc(note)}</p>` : ""}`;
}

function donut(segs, centerVal, centerLab) {
  const tot = segs.reduce((a, s) => a + s.v, 0);
  if (!tot) return emptyMini("No classified records in range");
  let acc = 0;
  const stops = segs.filter(s => s.v > 0).map(s => {
    const from = (acc / tot) * 360, to = ((acc + s.v) / tot) * 360;
    acc += s.v;
    return `${s.c} ${from}deg ${to}deg`;
  });
  return `<div class="donut-wrap">
    <div class="donut" style="background:conic-gradient(${stops.join(",")})"><div class="cen"><b>${centerVal}</b><span>${esc(centerLab)}</span></div></div>
    <div class="dleg">${segs.map(s => `<span><i style="background:${s.c}"></i>${esc(s.l)}<b>${s.v}</b></span>`).join("")}</div>
  </div>`;
}

function emptyMini(msg) {
  return `<div class="empty mini"><p>${esc(msg)}</p></div>`;
}

/**
 * Notes attached to a channel. Having a note does NOT mean the channel is
 * disconnected — Blogs and Web both carry coverage notes and work perfectly well.
 * Conflating the two rendered working channels as "not connected".
 */
function channelNotes(channelId) {
  const cav = (DATA.meta.caveats && DATA.meta.caveats.by_channel) || {};
  const dormant = (DATA.meta.caveats && DATA.meta.caveats.dormant) || [];
  const notes = cav[channelId] || [];
  const rel = dormant.find(d =>
    (channelId === "linkedin" && d.adapter === "linkedin") ||
    (channelId === "x" && d.adapter === "x_twikit")
  );
  if (!notes.length && !rel) return null;
  return { notes, dormant: rel };
}

/**
 * Is this channel genuinely unable to produce data at all?
 * Judged on whether the channel has ANY records across the whole dataset — not on
 * the current filter. A channel with 85 records total is connected, even if the
 * active range happens to contain none of them.
 */
function channelConnected(channelId) {
  for (const id of DATA.meta.brand_order) {
    const b = DATA.brands[id];
    if ((b.stats.by_channel || {})[channelId] > 0) return true;
  }
  return false;
}

function channelStatusChip(channelId, count) {
  if (count > 0) return "";
  if (!channelConnected(channelId)) return `<span class="chip nc">no source connected</span>`;
  // Connected, just nothing in the current filter — a real, honest zero.
  return `<span class="chip zero">none in range</span>`;
}

/* -------------------------------------------------------------- caveat UI */
function caveatBanner() {
  const c = DATA.meta.caveats || {};
  const items = [];
  (c.global || []).forEach(t => items.push({ sev: "warn", text: t }));
  const rangeNotes = (c.by_range && c.by_range[STATE.range]) || [];
  rangeNotes.forEach(t => items.push({ sev: "info", text: t }));
  if (!items.length) return "";
  return `<div class="caveats">${items.map(i => `<div class="cav ${i.sev}">
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"/><path d="M12 16v-4M12 8h.01"/></svg>
    <span>${esc(i.text)}</span></div>`).join("")}</div>`;
}

function integrityStrip() {
  const i = DATA.meta.integrity;
  const unclass = i.sentiment_unclassified;
  return `<div class="istrip">
    <span><b>${i.verified_records}</b> verified records</span>
    <span><b>${i.with_exact_date}</b> with a proven date</span>
    <span class="${i.without_date ? "amber" : ""}"><b>${i.without_date}</b> undated <em>(excluded from ranges)</em></span>
    <span class="${i.links_broken ? "amber" : ""}"><b>${i.links_verified_working}</b>/${i.verified_records} links verified live</span>
    <span class="${unclass ? "amber" : ""}"><b>${i.sentiment_classified}</b> sentiment-classified${unclass ? ` <em>(${unclass} pending)</em>` : ""}</span>
    <button class="linky" data-goto="sources">How this is verified →</button>
  </div>`;
}

/* --------------------------------------------------------- view: overview */
function viewOverview() {
  const b = brand();
  const ms = filtered();
  // Channel counts come from the set WITHOUT the channel filter, so selecting one
  // channel cannot zero the others (which previously rendered them "not connected").
  const msNoChan = filtered(null, { excludeChannelFilter: true });
  const chCounts = DATA.meta.channels.map(c => ({
    id: c.id,
    label: c.label,
    value: msNoChan.filter(m => m.channel === c.id).length,
    total: (b.stats.by_channel || {})[c.id] || 0,
  }));
  const sent = { positive: 0, negative: 0, neutral: 0, unclassified: 0 };
  ms.forEach(m => sent[m.sentiment || "unclassified"]++);
  const classified = sent.positive + sent.negative + sent.neutral;
  const share = allBrandCounts().sort((a, c) => c.value - a.value);
  const shareTotal = share.reduce((a, s) => a + s.value, 0);
  const myShare = pct(ms.length, shareTotal);
  const aiSum = DATA.ai && DATA.ai.claude && DATA.ai.claude.summary ? DATA.ai.claude.summary[STATE.brand] : null;

  return `
  <h1 class="vh">${esc(b.name)} — competitive snapshot</h1>
  <p class="vsub">Every figure below is computed only from records whose source page was fetched, whose brand mention was confirmed in that page's text, and which carry an auditable excerpt. ${esc(RANGE_LABELS[STATE.range])}.</p>
  ${integrityStrip()}
  ${caveatBanner()}

  <div class="kpis">
    <div class="card kpi">
      <div class="l">Verified mentions</div>
      <div class="v tnum">${ms.length}</div>
      <div class="d">${esc(RANGE_LABELS[STATE.range])}${b.stats.undated ? ` · ${b.stats.undated} undated excluded` : ""}</div>
    </div>
    <div class="card kpi">
      <div class="l">Share of voice</div>
      <div class="v tnum">${myShare == null ? "—" : myShare + "%"}</div>
      <div class="d">of ${shareTotal} mentions across all 7 tracked products</div>
    </div>
    <div class="card kpi">
      <div class="l">Sentiment</div>
      ${classified
        ? `<div class="v tnum"><span style="color:var(--pos)">${sent.positive}</span><small style="color:var(--ink-3)"> / </small><span style="color:var(--neg)">${sent.negative}</span></div>
           <div class="d">${pct(sent.positive, classified)}% positive of ${classified} classified${sent.unclassified ? ` · ${sent.unclassified} unclassified` : ""}</div>`
        : `<div class="v" style="font-size:20px;color:var(--ink-3)">unclassified</div>
           <div class="d">${sent.unclassified} record(s) awaiting Claude classification</div>`}
    </div>
    <div class="card kpi">
      <div class="l">Share of Claude answers</div>
      ${aiSum && aiSum.share_pct != null
        ? `<div class="v tnum" style="color:var(--brand)">${aiSum.share_pct}%</div>
           <div class="d">named in ${aiSum.present_in}/${aiSum.prompts_measured} buyer prompts${aiSum.median_position ? ` · median rank ${aiSum.median_position}` : ""}</div>`
        : `<div class="v" style="font-size:20px;color:var(--ink-3)">not measured</div>
           <div class="d">run <code>/refresh-intel</code> to measure</div>`}
    </div>
  </div>

  <div class="grid2">
    <div class="card panel">
      <div class="panel-h"><h2>Share of voice — all 7 products</h2><span class="hint">${esc(RANGE_LABELS[STATE.range])}</span></div>
      ${hbars(share.map(s => ({ label: s.name, value: s.value, hi: s.hi })), {
        note: "Verified mentions per product in this range. Confluence and Guru counts apply name-disambiguation, so generic uses of those words are excluded.",
      })}
    </div>
    <div class="card panel">
      <div class="panel-h"><h2>Sentiment mix</h2><span class="hint">${classified} classified</span></div>
      ${donut(
        [
          { l: "Positive", v: sent.positive, c: "var(--pos)" },
          { l: "Neutral", v: sent.neutral, c: "var(--neu)" },
          { l: "Negative", v: sent.negative, c: "var(--neg)" },
        ],
        classified ? pct(sent.positive, classified) + "%" : "—",
        "positive"
      )}
      ${sent.unclassified ? `<p class="chart-note">${sent.unclassified} record(s) are unclassified and excluded from this chart — "unknown" is not the same as "neutral".</p>` : ""}
    </div>
  </div>

  <div class="card panel" style="margin-top:14px">
    <div class="panel-h"><h2>Channel coverage</h2><span class="hint">the six tracked channels</span></div>
    <div class="chgrid">
      ${chCounts.map(c => {
        const connected = channelConnected(c.id);
        return `<button class="chcard ${STATE.channels.includes(c.id) ? "on" : ""} ${connected ? "" : "dead"}" data-chan="${c.id}"
          title="${connected ? `${c.value} in range · ${c.total} tracked all-time` : "no source connected for this channel"}">
          <span class="chico">${chIcon(c.id, 17)}</span>
          <span class="chlab">${esc(c.label)}</span>
          <span class="chval tnum">${connected ? c.value : "—"}</span>
          ${c.total > c.value ? `<span class="chall">${c.total} all-time</span>` : ""}
          ${channelStatusChip(c.id, c.value)}
        </button>`;
      }).join("")}
    </div>
    ${renderChannelNotes(chCounts)}
  </div>

  <div class="card panel" style="margin-top:14px">
    <div class="panel-h"><h2>Latest verified mentions</h2><button class="pill" data-goto="mentions">View all →</button></div>
    <div class="mentions">${ms.slice(0, 5).map(miniMention).join("") || emptyMini("No verified mentions in this range.")}</div>
  </div>`;
}

function renderChannelNotes(chCounts) {
  const out = [];
  for (const c of chCounts) {
    const nc = channelNotes(c.id);
    if (!nc) continue;

    // A channel that is producing data is NOT blocked. Previously an absent
    // LinkedIn cookie was rendered as "Blocked by: LINKEDIN_LI_AT not set" while
    // the channel was in fact returning records via SearXNG — alarming and wrong.
    // When data is flowing, the missing credential is optional enrichment
    // (engagement metrics), so it is presented that way.
    const hasData = c.total > 0;
    const blockers = nc.dormant ? nc.dormant.blockers : [];
    const how = nc.dormant ? nc.dormant.how_to_enable : null;

    out.push(`<div class="chnote ${hasData ? "" : "blocked"}">
      <b>${chIcon(c.id, 13)} ${esc(c.label)}
        ${hasData ? `<span class="chip ok">collecting</span>` : `<span class="chip bad">no data</span>`}</b>
      ${nc.notes.map(n => `<span>${esc(n)}</span>`).join("")}
      ${blockers.length
        ? hasData
          ? `<span class="how"><b>Optional enrichment not connected:</b> ${blockers.map(esc).join(" · ")}
             — this channel is already collecting without it; adding it would add engagement metrics only.</span>`
          : `<span class="blk"><b>Blocked:</b> ${blockers.map(esc).join(" · ")}</span>`
        : ""}
      ${how ? `<span class="how">${hasData ? "If you want the extra metrics" : "To enable"}: ${esc(how)}</span>` : ""}
    </div>`);
  }
  return out.length ? `<div class="chnotes">${out.join("")}</div>` : "";
}

function miniMention(m) {
  return `<div class="minim">
    <span class="m-fav sm">${favLetter(m.domain)}</span>
    <div class="minim-b">
      <a href="${esc(m.url)}" target="_blank" rel="noopener noreferrer">${esc(m.title || m.url)}</a>
      <div class="m-meta">
        <b>${esc(m.domain || "—")}</b><span class="sep">·</span>${chIcon(m.channel, 12)} ${esc(chLabel(m.channel))}
        <span class="sep">·</span>${dateCell(m)}
        <span class="sep">·</span>${sentBadge(m)}
        ${m.link_ok ? "" : '<span class="sep">·</span><span class="badge warn dot">link unreachable</span>'}
      </div>
    </div>
  </div>`;
}

/**
 * One date cell, always stating which axis produced it. A proven publication date
 * and a "we first saw this" date are different claims, so they must not render
 * identically — a reader has to be able to tell them apart at a glance.
 */
function dateCell(m) {
  if (m.date_basis === "published") {
    return `<span title="Publication date, proven from the page (${esc(m.date_method || "unknown")})">${fmtDate(m.date)}</span>`;
  }
  if (m.date_basis === "discovered") {
    return `<span class="disc" title="This page exposes no machine-readable publication date. Shown is when our collector first recorded the mention.">first seen ${fmtDate(m.first_seen)}</span>`;
  }
  return '<em class="undated" title="No date of any kind available">no date</em>';
}

/**
 * Verification grade. Three states that must stay visually distinct, because a
 * fact we fetched and a label a provider asserted are different evidence:
 *   verified  - we fetched the URL and confirmed the brand in its text
 *   provider  - an API asserted it; we did not independently re-fetch
 *   unverified
 */
function verifChip(m) {
  const s = m.verification_status;
  if (s === "verified") {
    return '<span class="chip ok" title="We fetched this URL and confirmed the brand appears in the page text.">verified</span>';
  }
  if (s === "provider") {
    return `<span class="chip prov" title="Asserted by ${esc(m.api_source || "the API")}; the URL was not independently re-fetched by us.">provider-reported</span>`;
  }
  return '<span class="chip warn" title="Not independently verified.">unverified</span>';
}

function sentBadge(m) {
  if (!m.sentiment) return '<span class="badge unc dot">unclassified</span>';
  const cls = m.sentiment === "positive" ? "pos" : m.sentiment === "negative" ? "neg" : "neu";
  return `<span class="badge ${cls} dot">${esc(m.sentiment)}</span>`;
}

/* --------------------------------------------------------- view: mentions */
const PER_PAGE = 10;

/**
 * THE main view: who is being mentioned, where, and what was said.
 *
 * One matrix (all brands x all channels), one row of filters, one list. No KPI
 * tiles, no donut, no bar chart — the matrix already answers "who leads where",
 * and the list answers "what was actually said".
 */
function viewMentions() {
  const b = brand();
  const order = DATA.meta.brand_order;
  const groups = DATA.meta.channel_groups || [];
  const chans = DATA.meta.channels;

  // Counts per brand per channel for the active range, independent of the
  // channel/sentiment filters so selecting one never zeroes the rest.
  const matrix = {};
  const rowTotal = {};
  for (const id of order) {
    const ms = (DATA.brands[id].mentions || []).filter(inRange);
    matrix[id] = {};
    for (const c of chans) matrix[id][c.id] = ms.filter(m => m.channel === c.id).length;
    rowTotal[id] = ms.length;
  }
  const colTotal = {};
  for (const c of chans) colTotal[c.id] = order.reduce((a, id) => a + matrix[id][c.id], 0);
  const grand = order.reduce((a, id) => a + rowTotal[id], 0);
  const maxRow = Math.max(1, ...order.map(id => rowTotal[id]));

  // Filter counts for the selected brand only.
  const mine = (b.mentions || []).filter(inRange);
  const sCounts = { positive: 0, negative: 0, neutral: 0, unclassified: 0 };
  mine.forEach(m => sCounts[m.sentiment || "unclassified"]++);

  return `
  <div class="mv-head">
    <h1 class="vh">Mentions across all channels</h1>
    <p class="vsub">${grand} verified mentions of ${order.length} products · ${esc(RANGE_LABELS[STATE.range])} · every row links to its source</p>
  </div>

  <div class="card matrix-card">
    <div class="tbl-scroll"><table class="matrix">
      <thead>
        <tr>
          <th class="mx-brand"></th>
          ${groups.map(g => `<th class="mx-group" colspan="${g.channels.length}">${esc(g.label)}</th>`).join("")}
          <th class="mx-tot">Total</th>
        </tr>
        <tr>
          <th class="mx-brand">Product</th>
          ${groups.map(g => g.channels.map(cid => {
            const c = chans.find(x => x.id === cid);
            return `<th class="mx-ch" title="${esc(c.label)}">${chIcon(cid, 14)}<span>${esc(c.label)}</span></th>`;
          }).join("")).join("")}
          <th class="mx-tot"></th>
        </tr>
      </thead>
      <tbody>
        ${order.map(id => {
          const isMe = id === STATE.brand;
          return `<tr class="${isMe ? "me" : ""}" data-brandrow="${id}" title="Click to view ${esc(brandName(id))}">
            <td class="mx-brand"><b>${esc(brandName(id))}</b>${DATA.brands[id].primary ? ' <span class="badge brand xs">you</span>' : ""}</td>
            ${groups.map(g => g.channels.map(cid => {
              const n = matrix[id][cid];
              return `<td class="mx-n ${n === 0 ? "z" : ""}">${n || "·"}</td>`;
            }).join("")).join("")}
            <td class="mx-tot">
              <span class="mx-bar"><i style="width:${(rowTotal[id] / maxRow * 100).toFixed(0)}%"></i></span>
              <b>${rowTotal[id]}</b>
            </td>
          </tr>`;
        }).join("")}
      </tbody>
      <tfoot><tr>
        <td class="mx-brand">All products</td>
        ${groups.map(g => g.channels.map(cid => `<td class="mx-n">${colTotal[cid] || "·"}</td>`).join("")).join("")}
        <td class="mx-tot"><b>${grand}</b></td>
      </tr></tfoot>
    </table></div>
  </div>

  <div class="mv-filters">
    <div class="fgroup">
      <span class="flab">Channel</span>
      ${chans.map(c => {
        const n = matrix[STATE.brand][c.id];
        const on = STATE.channels.includes(c.id);
        return `<button class="fchip ${on ? "on" : ""} ${n === 0 ? "empty" : ""}" data-chan="${c.id}">
          ${chIcon(c.id, 13)} ${esc(c.label)} <span class="fn">${n}</span></button>`;
      }).join("")}
    </div>
    <div class="fgroup">
      <span class="flab">Sentiment</span>
      ${[["positive", "Positive"], ["neutral", "Neutral"], ["negative", "Negative"], ["unclassified", "Unclassified"]].map(([id, lab]) => {
        const on = STATE.sentiments.includes(id);
        return `<button class="fchip s-${id} ${on ? "on" : ""} ${sCounts[id] === 0 ? "empty" : ""}" data-sent-btn="${id}">
          ${lab} <span class="fn">${sCounts[id]}</span></button>`;
      }).join("")}
      ${STATE.channels.length || STATE.sentiments.length ? `<button class="fchip clear" id="clearFilters">Clear</button>` : ""}
    </div>
  </div>

  <div class="feed-top">
    <div class="feed-count" id="feedCount"></div>
    <select class="control sortsel" id="sortSel">
      <option value="recent"${STATE.sort === "recent" ? " selected" : ""}>Newest first</option>
      <option value="oldest"${STATE.sort === "oldest" ? " selected" : ""}>Oldest first</option>
    </select>
  </div>
  <div class="mentions" id="mentionList"></div>
  <div class="pager" id="pager"></div>`;
}

/**
 * Mention card — delegated to public/js/premium.js.
 *
 * The markup lives there so the presentation layer (platform marks, brand
 * highlighting, relative time) can evolve without touching the state, filter and
 * routing logic in this file. Helpers are passed in explicitly rather than being
 * reached for globally, so there is no hidden load-order coupling.
 */
function mentionCard(m) {
  return window.D360Premium.mentionCard(m, {
    esc,
    brandName,
    fmtDate,
    verifChip,
    aliasesFor: id => (DATA.meta.brand_aliases && DATA.meta.brand_aliases[id]) || [brandName(id)],
  });
}

function renderMentionList() {
  const list = $("#mentionList");
  if (!list) return;
  const all = filtered();
  const pages = Math.max(1, Math.ceil(all.length / PER_PAGE));
  if (STATE.page > pages) STATE.page = 1;
  const slice = all.slice((STATE.page - 1) * PER_PAGE, STATE.page * PER_PAGE);
  const active = STATE.channels.length || STATE.sentiments.length;

  $("#feedCount").innerHTML = `<b>${all.length}</b> verified mention${all.length !== 1 ? "s" : ""}${active ? " (filtered)" : ""}`;
  list.innerHTML = slice.length
    ? slice.map(mentionCard).join("")
    : `<div class="empty"><p>No verified mentions match these filters.</p>
       <p class="sub">This is a real zero for the sources that are connected — it is not a placeholder. Check <button class="linky" data-goto="sources">Sources &amp; Integrity</button> to see which channels are unavailable.</p></div>`;

  const pg = $("#pager");
  if (pages > 1) {
    let html = `<button ${STATE.page === 1 ? "disabled" : ""} data-pg="${STATE.page - 1}">‹</button>`;
    for (let i = 1; i <= pages; i++) {
      if (i === 1 || i === pages || Math.abs(i - STATE.page) <= 1) {
        html += `<button aria-current="${i === STATE.page}" data-pg="${i}">${i}</button>`;
      } else if (Math.abs(i - STATE.page) === 2) {
        html += `<span class="ell">…</span>`;
      }
    }
    html += `<button ${STATE.page === pages ? "disabled" : ""} data-pg="${STATE.page + 1}">›</button>`;
    pg.innerHTML = html;
  } else pg.innerHTML = "";
}

/* --------------------------------------------------------------- view: AI */
/**
 * The custom prompt search, per-surface results, over-time metrics, citation
 * analysis and probe history. These are ADDITIVE panels rendered above the
 * original measurement tables, which are unchanged below.
 */
function aiCustomPanels() {
  const A = window.D360AI;
  if (!A) return "";
  const ctx = { DATA, STATE, esc };
  const metrics = (window.__d360_ai_metrics && (window.__d360_ai_metrics.brands || []).find(b => b.brand_id === STATE.brand)) || null;
  const avail = (window.__d360_ai_metrics && window.__d360_ai_metrics.availability) || {};
  return [
    A.promptSearchPanel(ctx),
    A.metricsPanel(metrics, avail),
    // The outcome layer sits directly under the appearance metrics, because the
    // two only mean something read together.
    A.referralPanel(window.__d360_referrals, STATE.brand, brandName(STATE.brand)),
    A.citationPanel(window.__d360_citations, STATE.brand, brandName(STATE.brand)),
    A.historyPanel(window.__d360_ai_history, STATE.brand),
  ].join("");
}

function viewAI() {
  const ai = DATA.ai || {};
  if (!ai.claude || ai.claude.status !== "measured") {
    // The prompt search still works with no batch measurement — it is a live,
    // independent measurement path, so it must not be gated behind one.
    return `<h1 class="vh">AI Answer Visibility</h1>
    ${aiCustomPanels()}
    <div class="empty big">
      <h3>The batch measurement has not been run</h3>
      <p>${esc(ai.reason || "No batch AI-visibility measurement has been run.")}</p>
      <p class="sub">Nothing is estimated here. The prompt search above works independently and measures live. For the full 10-prompt batch across all 7 products, run <code>/refresh-intel</code> in Claude Code, or <code>node collectors/claude/ai-visibility.js build</code>.</p>
    </div>`;
  }

  const results = ai.claude.results || [];
  const summary = ai.claude.summary || {};
  const web = ai.web || { status: "not_connected" };
  const others = ai.other_models || {};
  const order = DATA.meta.brand_order;

  // The web column has FOUR possible states and they mean different things:
  //   measured            - fully measured
  //   partially_measured  - some prompts blocked; shares computed over the rest
  //   measurement_failed  - nothing measured. NOT the same as "absent everywhere".
  //   not_connected       - no SERP provider at all
  const webMeasured = web.status === "measured" || web.status === "partially_measured";

  return `
  <h1 class="vh">AI Answer Visibility — all 7 tracked products</h1>

  ${aiCustomPanels()}

  <h2 class="vh2">Batch measurement</h2>
  <p class="vsub">A fixed set of ${results.length} buyer-intent prompts, answered by Claude from its own knowledge, with every brand it claimed to name verified against its verbatim answer text. Brand claims not present in the answer were discarded${ai.audit && ai.audit.brands_dropped_not_in_answer ? ` (${ai.audit.brands_dropped_not_in_answer} dropped)` : ""}.</p>

  <div class="note">
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"/><path d="M12 16v-4M12 8h.01"/></svg>
    <div>This batch is a <b>separate, older measurement</b> from the prompt search above, kept because it
    covers all 7 products on identical prompts. It measures Claude's <b>native</b> answers with no web
    search${webMeasured ? `, alongside real ranked SERP results` : ""} — deliberately different from the
    prompt search, which asks each surface live <b>with</b> web search. Use the panels above for current
    visibility; use this table to compare products on one fixed prompt set.</div>
  </div>

  <div class="card panel" style="margin-bottom:14px">
    <div class="panel-h"><h2>Share of AI answers by product</h2><span class="hint">${results.length} prompts · Claude native</span></div>
    <div class="tbl-scroll"><table class="ptable wide">
      <thead><tr><th>Product</th><th>Named in</th><th>Share</th><th>Median rank</th><th>Best rank</th><th>Sentiment in answers</th></tr></thead>
      <tbody>${order.map(id => {
        const s = summary[id] || {};
        const sc = s.sentiment_counts || {};
        const isMe = id === STATE.brand;
        return `<tr class="${isMe ? "me" : ""}">
          <td><b>${esc(brandName(id))}</b>${DATA.brands[id] && DATA.brands[id].primary ? ' <span class="badge brand xs">you</span>' : ""}</td>
          <td class="tnum">${s.present_in ?? 0}/${s.prompts_measured ?? results.length}</td>
          <td><span class="sharebar"><i style="width:${s.share_pct || 0}%"></i></span><span class="tnum">${s.share_pct ?? 0}%</span></td>
          <td class="tnum">${s.median_position ?? "—"}</td>
          <td class="tnum">${s.best_position ?? "—"}</td>
          <td>${["positive", "neutral", "negative"].filter(k => sc[k]).map(k => `<span class="badge ${k === "positive" ? "pos" : k === "negative" ? "neg" : "neu"} dot">${sc[k]} ${k}</span>`).join(" ") || '<span class="muted">—</span>'}</td>
        </tr>`;
      }).join("")}</tbody>
    </table></div>
  </div>

  <div class="card panel" style="margin-bottom:14px">
    <div class="panel-h"><h2>Where ${esc(brandName(STATE.brand))} ranks, prompt by prompt</h2><span class="livechip">Claude · measured</span></div>
    <div class="tbl-scroll"><table class="ptable">
      <thead><tr><th>Buyer prompt</th><th>Rank</th><th>Named as</th><th>Sentiment</th><th>Total products named</th></tr></thead>
      <tbody>${results.map(r => {
        const t = r.tracked && r.tracked[STATE.brand];
        const s = r.tracked_sentiment && r.tracked_sentiment[STATE.brand];
        return `<tr>
          <td class="q">${esc(r.prompt)}</td>
          <td class="${t ? "pos-pill" + (t.position === 1 ? " rank1" : "") : ""}">${t && t.position ? "#" + t.position : '<span class="absent">absent</span>'}</td>
          <td>${t ? `<code>${esc(t.as_written)}</code>` : '<span class="muted">—</span>'}</td>
          <td>${s ? `<span class="badge ${s === "positive" ? "pos" : s === "negative" ? "neg" : "neu"} dot">${esc(s)}</span>` : '<span class="muted">—</span>'}</td>
          <td class="tnum">${r.total_brands_named}</td>
        </tr>`;
      }).join("")}</tbody>
    </table></div>
    <p class="chart-note">"absent" is a measured result, not missing data — it means Claude did not name ${esc(brandName(STATE.brand))} when answering that prompt.</p>
  </div>`;
}

/* The "Key sources AI cites" panel was removed on request. Its job — naming the
 * domains that decide AI answers and showing which ones omit us — is done
 * better by the Citation analysis panel above, which is built from live
 * per-prompt probes rather than the batch SERP snapshot. */

/* ---------------------------------------------------- view: recommendations */
function viewRecs() {
  const R = DATA.recommendations || {};
  const recs = R.recommendations || [];
  if (!recs.length) {
    return `<h1 class="vh">Recommendations</h1>
    <div class="empty big">
      <h3>Not generated yet</h3>
      <p>${esc(R.reason || "No recommendations have been generated.")}</p>
      <p class="sub">Recommendations are only produced from the verified evidence store, and each must cite record ids that resolve against it. Run <code>/refresh-intel</code> in Claude Code.</p>
    </div>`;
  }

  const owners = [...new Set(recs.map(r => r.owner))].sort();
  const shown = recs.filter(r =>
    (STATE.recType === "all" || r.type === STATE.recType) &&
    (STATE.recOwner === "all" || r.owner === STATE.recOwner)
  );
  const byType = t => recs.filter(r => r.type === t).length;

  return `
  <h1 class="vh">Recommendations</h1>
  <p class="vsub">Every recommendation cites verified records from the evidence store. ${R.audit ? `${R.audit.accepted} accepted, ${R.audit.rejected} rejected for citing evidence that could not be resolved.` : ""}</p>
  <div class="note">
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"/><path d="M12 16v-4M12 8h.01"/></svg>
    <div>${esc(R.method || "")}</div>
  </div>
  <div class="rec-filters">
    <button class="pill" data-rectype="all" aria-pressed="${STATE.recType === "all"}">All <span class="pc">${recs.length}</span></button>
    <button class="pill" data-rectype="capitalize_competitor" aria-pressed="${STATE.recType === "capitalize_competitor"}">Capitalize <span class="pc">${byType("capitalize_competitor")}</span></button>
    <button class="pill" data-rectype="accelerate_llm" aria-pressed="${STATE.recType === "accelerate_llm"}">Accelerate in AI <span class="pc">${byType("accelerate_llm")}</span></button>
    <button class="pill" data-rectype="defend_position" aria-pressed="${STATE.recType === "defend_position"}">Defend <span class="pc">${byType("defend_position")}</span></button>
    <span class="vdiv"></span>
    <select class="control" id="recOwnerSel"><option value="all"${STATE.recOwner === "all" ? " selected" : ""}>All owners</option>${owners.map(o => `<option value="${esc(o)}"${STATE.recOwner === o ? " selected" : ""}>${esc(o)}</option>`).join("")}</select>
  </div>
  <div class="feed-count" style="margin-bottom:12px"><b>${shown.length}</b> recommendation${shown.length !== 1 ? "s" : ""}</div>
  <div class="recs">${shown.map(recCard).join("") || emptyMini("No recommendations for this filter.")}</div>`;
}

function recCard(r) {
  const typeLabel = { capitalize_competitor: "Capitalize", accelerate_llm: "Accelerate in AI", defend_position: "Defend" }[r.type] || r.type;
  const typeTag = { capitalize_competitor: "type-cap", accelerate_llm: "type-llm", defend_position: "type-def" }[r.type] || "";
  return `<article class="card rec">
    <div class="rec-top">
      <span class="tag chan">${esc(r.owner)}</span>
      <span class="tag ${typeTag}">${typeLabel}</span>
      <span class="tag pri-${esc(r.priority)}">${esc(r.priority)} priority</span>
      ${r.competitor ? `<span class="comp">vs ${esc(r.competitor)}</span>` : ""}
    </div>
    <h3>${esc(r.title)}</h3>
    <p class="detail">${esc(r.detail)}</p>
    ${r.reasoning ? `<p class="reasoning"><b>Why:</b> ${esc(r.reasoning)}</p>` : ""}
    <div class="ev-list">
      <div class="ev-h">Grounded in ${r.evidence.length} verified record${r.evidence.length !== 1 ? "s" : ""}</div>
      ${r.evidence.map(e => `<div class="ev-item">
        <a href="${esc(e.url)}" target="_blank" rel="noopener noreferrer">${esc(e.title || e.domain)}</a>
        <span class="ev-meta">${esc(e.brand)} · ${esc(chLabel(e.channel))} · ${e.date ? fmtDate(e.date) : "no date"}${e.sentiment ? ` · ${esc(e.sentiment)}` : ""}${e.link_verified ? "" : " · link dead"}</span>
        <blockquote>${esc(e.excerpt)}</blockquote>
      </div>`).join("")}
    </div>
  </article>`;
}

/* ---------------------------------------------------------- view: sources */
function viewSources() {
  const i = DATA.meta.integrity;
  const dq = DATA.meta.data_quality || null;
  const fr = DATA.meta.data_freshness || {};
  const c = DATA.meta.caveats || {};
  const dw = DATA.meta.data_window || {};
  const t = DATA.meta.totals || {};

  return `
  <h1 class="vh">Sources &amp; Integrity</h1>
  <p class="vsub">What was measured, how, and what is missing. ${esc(i.rule)}</p>

  ${dq ? `<div class="istrip">
    <span><b>Last updated</b> ${fmtDateTime(DATA.meta.last_updated)}</span>
    <span>newest mention <b>${fr.newest_published ? fmtDate(fr.newest_published) : "—"}</b>${fr.newest_published_age_days != null ? ` <em>(${fr.newest_published_age_days}d old)</em>` : ""}</span>
    <span>last sync <b>${dq.last_successful_sync ? fmtDateTime(dq.last_successful_sync) : "never"}</b>${dq.last_sync_window_days ? ` <em>(${dq.last_sync_window_days}d window)</em>` : ""}</span>
  </div>` : ""}

  <div class="kpis">
    <div class="card kpi"><div class="l">Records retrieved</div><div class="v tnum">${dq ? dq.records_retrieved : i.verified_records}</div><div class="d">${dq ? dq.duplicates_removed : 0} duplicates removed</div></div>
    <div class="card kpi"><div class="l">Verified</div><div class="v tnum">${dq ? dq.records_verified : i.verified_records}</div><div class="d">fetched + brand confirmed in page text</div></div>
    <div class="card kpi"><div class="l">Provider-reported</div><div class="v tnum">${dq ? dq.records_provider_only : 0}</div><div class="d">API-asserted, URL not re-fetched</div></div>
    <div class="card kpi"><div class="l">Sentiment classified</div><div class="v tnum">${i.sentiment_classified}</div><div class="d">${i.sentiment_unclassified} pending · never counted as neutral</div></div>
  </div>

  ${dq ? `<div class="grid2" style="margin-top:14px">
    <div class="card panel">
      <div class="panel-h"><h2>Data quality counters</h2><span class="hint">every number is a real counter from this build</span></div>
      <table class="ptable"><tbody>
        ${[
          ["Records retrieved", dq.records_retrieved, null],
          ["Verified (fetched + confirmed)", dq.records_verified, null],
          ["Provider-reported only", dq.records_provider_only, "asserted by an API; not independently re-fetched"],
          ["AI-classified (sentiment)", dq.records_ai_classified, "model judgement, grounded in a quoted excerpt"],
          ["Unclassified", dq.records_unclassified, "excluded from every sentiment figure"],
          ["Duplicates removed", dq.duplicates_removed, Object.entries(dq.duplicates_by_reason || {}).map(([k, v]) => `${v} ${k}`).join(" · ")],
          ["Cross-source corroborated", dq.cross_source_corroborated, "same item confirmed by more than one API"],
          ["Low-relevance records", dq.low_relevance_records, "provider relevance below 0.4"],
          ["Uncertain classifications", dq.uncertain_classifications, "product-resolution confidence below 0.7"],
          ["Missing URLs", dq.missing_urls, null],
          ["Links verified working", dq.links_verified_working, null],
          ["Links broken", dq.links_broken, null],
          ["Rejected this run", dq.rejected_this_run, "see the excluded-records table below"],
        ].map(([lab, val, note]) => `<tr><td>${esc(lab)}${note ? `<br><span class="muted" style="font-size:11px">${esc(note)}</span>` : ""}</td><td class="tnum" style="text-align:right;vertical-align:top">${val}</td></tr>`).join("")}
      </tbody></table>
    </div>
    <div class="card panel">
      <div class="panel-h"><h2>Sources &amp; credentials</h2></div>
      <table class="ptable"><tbody>
        ${Object.entries(dq.by_api_source || {}).sort((a, b) => b[1] - a[1]).map(([k, v]) =>
          `<tr><td><code>${esc(k)}</code></td><td class="tnum" style="text-align:right">${v}</td></tr>`).join("")}
      </tbody></table>
      <div class="ev-h" style="margin-top:14px">API credentials loaded</div>
      <div class="capgrid">
        ${(dq.credentials || []).map(c =>
          `<span class="cap ${c.present ? "yes" : "no"}" title="${c.present ? "loaded from .env (server-side only)" : "not set"}">${c.present ? "✓" : "✕"} ${esc(c.name)}${c.present ? ` ${esc(c.hint)}` : ""}</span>`).join("")}
      </div>
      <p class="chart-note">Keys are read server-side from <code>.env</code> and never sent to the browser — only the redacted hint above is exposed.</p>
      ${(dq.api_errors || []).length ? `<div class="ev-h" style="margin-top:14px">API errors this run (${dq.api_errors.length})</div>
        <div class="dormlist">${dq.api_errors.slice(0, 8).map(e =>
          `<div class="dorm"><b>${esc(e.adapter)}</b><span class="blk">${esc(e.error)}</span></div>`).join("")}</div>` : ""}
    </div>
  </div>` : ""}

  ${c.serp_provider ? `<div class="card panel">
    <div class="panel-h">
      <h2>Web search provider</h2>
      <span class="chip ${c.serp_provider.degraded ? "warn" : "ok"}">${esc(c.serp_provider.id)}</span>
    </div>
    <p class="provline"><b>${esc(c.serp_provider.label)}</b></p>
    <p class="chart-note">${esc(c.serp_provider.note || "")}</p>
    ${c.serp_provider.capabilities ? `<div class="capgrid">
      ${[["site: operator", c.serp_provider.capabilities.site_operator],
         ["qualifier terms", c.serp_provider.capabilities.qualifier_terms],
         ["date filter", c.serp_provider.capabilities.date_filter]]
        .map(([k, v]) => `<span class="cap ${v ? "yes" : "no"}">${v ? "✓" : "✕"} ${esc(k)}</span>`).join("")}
      <span class="cap yes">serves: ${(c.serp_provider.capabilities.serves_channels || []).map(x => esc(chLabel(x))).join(", ")}</span>
      ${(c.serp_provider.capabilities.cannot_serve_channels || []).length
        ? `<span class="cap no">cannot serve: ${c.serp_provider.capabilities.cannot_serve_channels.map(x => esc(chLabel(x))).join(", ")}</span>` : ""}
    </div>` : ""}
  </div>` : ""}

  <div class="card panel" style="margin-top:14px">
    <div class="panel-h"><h2>How a record earns its place</h2></div>
    <ol class="gate">
      <li><b>Fetch</b> — the URL is requested and the HTTP status, byte count and SHA-256 of the body are recorded.</li>
      <li><b>Confirm</b> — a brand alias must literally appear in the fetched text. For <b>Confluence</b> and <b>Guru</b>, whose names are ordinary English words, corroborating product context is also required and phrases like "a confluence of" or "SEO guru" are rejected outright.</li>
      <li><b>Evidence</b> — a verbatim excerpt containing the brand name is extracted, scored to prefer prose over navigation, and stored.</li>
      <li><b>Date</b> — parsed from JSON-LD, meta tags, <code>&lt;time&gt;</code>, or an authoritative feed. If none exists the record is marked undated and never enters a date range.</li>
      <li><b>Sentiment</b> — Claude classifies from the excerpt alone, with no URL or domain shown, and must return a quote that is a contiguous substring of it. A quote that is not literally present causes the classification to be discarded.</li>
    </ol>
  </div>

  <div class="grid2" style="margin-top:14px">
    <div class="card panel">
      <div class="panel-h"><h2>Date coverage</h2></div>
      <table class="ptable"><tbody>
        <tr><td>Earliest dated mention</td><td class="tnum">${dw.earliest_dated_mention ? fmtDate(dw.earliest_dated_mention) : "—"}</td></tr>
        <tr><td>Latest dated mention</td><td class="tnum">${dw.latest_dated_mention ? fmtDate(dw.latest_dated_mention) : "—"}</td></tr>
        ${DATA.meta.ranges.map(d => `<tr><td>Records within ${d} days</td><td class="tnum">${(t.ranges && t.ranges[d] && t.ranges[d].total) ?? 0}</td></tr>`).join("")}
        <tr><td>Undated (in no range)</td><td class="tnum">${t.undated ?? 0}</td></tr>
      </tbody></table>
      <p class="chart-note">${esc(dw.note || "")}</p>
    </div>
    <div class="card panel">
      <div class="panel-h"><h2>Unavailable sources</h2></div>
      ${(c.dormant || []).length ? `<div class="dormlist">${c.dormant.map(d => `<div class="dorm">
        <b>${esc(d.label)}</b>
        ${(d.blockers || []).map(x => `<span class="blk">${esc(x)}</span>`).join("")}
        ${d.how_to_enable ? `<span class="how"><b>Enable:</b> ${esc(d.how_to_enable)}</span>` : ""}
        ${d.fallback_in_use ? `<span class="how"><b>Fallback:</b> ${esc(d.fallback_in_use)}</span>` : ""}
      </div>`).join("")}</div>` : emptyMini("All configured sources ran.")}
    </div>
  </div>

  <div class="card panel" style="margin-top:14px">
    <div class="panel-h"><h2>Known coverage limits</h2><span class="hint">these bound what the numbers can mean</span></div>
    ${Object.keys(c.by_channel || {}).length || (c.global || []).length || Object.keys(c.by_range || {}).length
      ? `<ul class="cavlist">
          ${(c.global || []).map(x => `<li><b>All channels</b> ${esc(x)}</li>`).join("")}
          ${Object.entries(c.by_channel || {}).map(([ch, arr]) => arr.map(x => `<li><b>${esc(chLabel(ch))}</b> ${esc(x)}</li>`).join("")).join("")}
          ${Object.entries(c.by_range || {}).map(([d, arr]) => arr.map(x => `<li><b>${esc(d)}-day range</b> ${esc(x)}</li>`).join("")).join("")}
        </ul>`
      : emptyMini("No coverage limits recorded.")}
  </div>

  <div class="card panel" style="margin-top:14px">
    <div class="panel-h"><h2>Per-product source wiring</h2></div>
    <div class="tbl-scroll"><table class="ptable wide">
      <thead><tr><th>Product</th><th>Blog feed</th><th>YouTube channel</th><th>LinkedIn</th><th>X</th><th>Name disambiguation</th></tr></thead>
      <tbody>${DATA.meta.brand_order.map(id => {
        const b = DATA.brands[id];
        const cs = b.channel_sources || {};
        return `<tr>
          <td><b>${esc(b.name)}</b></td>
          <td>${cs.blog && cs.blog.endpoint ? '<span class="chip ok">RSS</span>' : `<span class="chip bad" title="${esc((cs.blog && cs.blog.note) || "")}">none</span>`}</td>
          <td>${cs.video && cs.video.endpoint ? '<span class="chip ok">channel RSS</span>' : `<span class="chip bad" title="${esc((cs.video && cs.video.note) || "")}">none</span>`}</td>
          <td><span class="chip nc">gated</span></td>
          <td><span class="chip nc">gated</span></td>
          <td>${b.ambiguous ? `<span class="chip warn" title="${esc(b.ambiguity_note || "")}">applied</span>` : '<span class="muted">not needed</span>'}</td>
        </tr>`;
      }).join("")}</tbody>
    </table></div>
  </div>

  <div class="card panel" style="margin-top:14px">
    <div class="panel-h"><h2>Excluded records</h2><button class="pill" id="loadAudit">Load audit →</button></div>
    <div id="auditBox"><p class="chart-note">${i.unverified_excluded} record(s) were collected but failed the gate, plus the legacy re-verification rejections. Load to inspect each with its reason.</p></div>
  </div>`;
}

/* ---------------------------------------------------------- provenance modal */
function showProvenance(url) {
  const m = (brand().mentions || []).find(x => x.url === url);
  if (!m) return;
  $("#modalCard").innerHTML = `
    <button class="close" data-mclose>×</button>
    <h2>Provenance</h2>
    <p class="genby">Every field below was recorded at collection time. Nothing here is inferred.</p>
    <table class="prov">
      <tr><td>Product</td><td><b>${esc(brandName(m.brand))}</b></td></tr>
      <tr><td>Channel</td><td>${esc(chLabel(m.channel))}</td></tr>
      <tr><td>URL</td><td><a href="${esc(m.url)}" target="_blank" rel="noopener">${esc(m.url)}</a></td></tr>
      <tr><td>HTTP status</td><td>${m.http_status ?? "—"} ${m.link_ok ? '<span class="chip ok">live</span>' : '<span class="chip bad">unreachable</span>'}</td></tr>
      <tr><td>Verified via</td><td>${esc(m.verified_via || "—")}</td></tr>
      <tr><td>Collected by</td><td><code>${esc(m.source)}</code></td></tr>
      <tr><td>Fetched at</td><td>${fmtDateTime(m.fetched_at)}</td></tr>
      <tr><td>Publication date</td><td>${m.date ? `${fmtDate(m.date)} <span class="muted">(${esc(m.date_method)})</span>` : '<em>none provable — excluded from date ranges</em>'}</td></tr>
      <tr><td>Matched alias</td><td><code>${esc(m.matched_alias || "—")}</code>${m.match_context ? ` <span class="muted">context: ${esc(m.match_context)}</span>` : ""}</td></tr>
      <tr><td>Sentiment</td><td>${m.sentiment ? `${esc(m.sentiment)} <span class="muted">(${esc(m.sentiment_method || "")})</span>` : "<em>unclassified</em>"}</td></tr>
    </table>
    <h4>Evidence excerpt</h4>
    <blockquote class="evidence">${esc(m.evidence)}</blockquote>
    ${m.sentiment_quote ? `<h4>Quote the sentiment was judged from</h4><blockquote class="evidence">${esc(m.sentiment_quote)}</blockquote>` : ""}`;
  $("#modal").classList.add("open");
}

async function loadAudit() {
  const box = $("#auditBox");
  box.innerHTML = '<p class="chart-note">Loading…</p>';
  try {
    const a = await (await fetch("/api/audit")).json();
    const ex = a.excluded_unverified || [];
    const lg = a.legacy_reverification;
    box.innerHTML = `
      ${lg ? `<p class="chart-note"><b>Legacy snapshot re-verification:</b> ${lg.passed} of ${lg.submitted} old mentions passed the gate; ${lg.rejected} were rejected. ${esc(lg.note || "")}</p>` : ""}
      <div class="tbl-scroll" style="max-height:340px"><table class="ptable">
        <thead><tr><th>Product</th><th>URL</th><th>Why excluded</th></tr></thead>
        <tbody>${[...ex.map(r => ({ b: r.brand, u: r.url, why: r.reason })),
          ...((lg && lg.rejections) || []).map(r => ({ b: r.brand_id, u: r.url, why: r.reason }))]
          .slice(0, 200)
          .map(r => `<tr><td>${esc(brandName(r.b) || r.b || "—")}</td><td class="urlcell"><a href="${esc(r.u)}" target="_blank" rel="noopener">${esc((r.u || "").slice(0, 70))}</a></td><td>${esc(r.why)}</td></tr>`).join("") ||
          '<tr><td colspan="3">Nothing excluded.</td></tr>'}
        </tbody></table></div>`;
  } catch (e) {
    box.innerHTML = '<p class="chart-note">Could not load /api/audit.</p>';
  }
}

/* ---------------------------------------------------------------- render */
function render() {
  $("#tabs").innerHTML = TABS.map(t => {
    const cnt = {
      mentions: filtered().length,
      recommendations: (DATA.recommendations && (DATA.recommendations.recommendations || []).length) || null,
      competitors: (DATA.competitors && (DATA.competitors.competitors || []).length) || null,
    }[t.id];
    return `<button class="tab" data-tab="${t.id}" aria-selected="${STATE.view === t.id}">${t.label}${cnt != null ? `<span class="cnt tnum">${cnt}</span>` : ""}</button>`;
  }).join("");

  const viewCtx = () => ({ esc, DATA, fmtDate, fmtDateTime, render });
  const map = {
    mentions: viewMentions,
    competitors: () => window.D360Views.viewCompetitors(viewCtx()),
    ai: viewAI,
    recommendations: viewRecs,
    sources: viewSources,
    settings: () => window.D360Views.viewSettings(viewCtx()),
  };

  // NOTE: the `active` class is required — styles.css sets `.view{display:none}`
  // and only `.view.active` is visible. Omitting it renders the whole view into
  // the DOM and then hides it, which looks exactly like "no data".
  let body;
  try {
    body = (map[STATE.view] || viewOverview)();
  } catch (err) {
    // Never leave a blank page. A view that throws must say so, because a silent
    // blank screen is indistinguishable from an empty dataset.
    console.error("view render failed:", err);
    body = `<div class="empty big">
      <h3>This view failed to render</h3>
      <p>The data loaded (${DATA.meta.integrity.verified_records} verified records), but building the
      <b>${esc(STATE.view)}</b> view threw an error. This is a bug in the dashboard, not missing data.</p>
      <p class="sub"><code>${esc(String(err && err.message || err))}</code></p>
      <p class="sub">Full stack is in the browser console.</p>
    </div>`;
  }
  $("#views").innerHTML = `<section class="view active">${body}</section>`;

  if (STATE.view === "mentions") {
    try { renderMentionList(); } catch (err) { console.error("mention list failed:", err); }
  }
  if (STATE.view === "settings") {
    try { window.D360Views.bindSettings(viewCtx()); } catch (err) { console.error("settings bind failed:", err); }
    if (!window.__d360_digest_loaded) {
      window.__d360_digest_loaded = true;
      window.D360Views.loadDigest()
        .then(() => { if (STATE.view === "settings") render(); })
        .catch(() => {});
    }
  }
  if (STATE.view === "ai") {
    // Bind after the HTML is in the DOM, and re-render once the side payloads
    // (metrics, history, citations) arrive so the panels fill in rather than
    // blocking the first paint on three extra requests.
    try { window.D360AI.bindAI({ DATA, STATE, esc }); } catch (err) { console.error("ai bind failed:", err); }
    if (!window.__d360_ai_loaded) {
      window.__d360_ai_loaded = true;
      Promise.all([window.D360AI.loadAiSide(), window.D360AI.loadCitations(STATE.brand)])
        .then(() => { if (STATE.view === "ai") render(); })
        .catch(() => {});
    }
  }
  if (STATE.view === "competitors") {
    try { window.D360Views.bindCompetitors(viewCtx()); } catch (err) { console.error("competitors bind failed:", err); }
    if (!window.__d360_dirs_loaded) {
      window.__d360_dirs_loaded = true;
      window.D360Directories.load()
        .then(() => { if (STATE.view === "competitors") render(); })
        .catch(() => {});
    }
  }
  $("#brandLabel").textContent = brand().name;
  $("#dateLabel").textContent = RANGE_LABELS[STATE.range];
  window.scrollTo({ top: 0 });
}
function go(v) { STATE.view = v; STATE.page = 1; render(); }

/* ---------------------------------------------------------------- events */
document.addEventListener("click", e => {
  const t = e.target;
  const tab = t.closest("[data-tab]"); if (tab) return go(tab.dataset.tab);
  const goto = t.closest("[data-goto]"); if (goto) return go(goto.dataset.goto);
  const pg = t.closest("[data-pg]");
  if (pg) { STATE.page = +pg.dataset.pg; renderMentionList(); $("#pager").scrollIntoView({ block: "nearest" }); return; }
  const brow = t.closest("[data-brandrow]");
  if (brow) { STATE.brand = brow.dataset.brandrow; STATE.page = 1; window.__d360_ai_loaded = false; return render(); }
  const sbtn = t.closest("[data-sent-btn]");
  if (sbtn) {
    const v = sbtn.dataset.sentBtn;
    STATE.sentiments = STATE.sentiments.includes(v) ? STATE.sentiments.filter(x => x !== v) : [...STATE.sentiments, v];
    STATE.page = 1; return render();
  }
  const fchip = t.closest(".fchip[data-chan]");
  if (fchip) {
    const id = fchip.dataset.chan;
    STATE.channels = STATE.channels.includes(id) ? STATE.channels.filter(x => x !== id) : [...STATE.channels, id];
    STATE.page = 1; return render();
  }
  const ch = t.closest(".chcard[data-chan]");
  if (ch) {
    const id = ch.dataset.chan;
    STATE.channels = STATE.channels.includes(id) ? STATE.channels.filter(x => x !== id) : [...STATE.channels, id];
    STATE.page = 1; return render();
  }
  if (t.closest("#clearFilters")) { STATE.channels = []; STATE.sentiments = []; STATE.page = 1; return render(); }
  const rt = t.closest("[data-rectype]"); if (rt) { STATE.recType = rt.dataset.rectype; return render(); }
  const prov = t.closest("[data-prov]"); if (prov) return showProvenance(prov.dataset.prov);
  if (t.closest("[data-mclose]") || t.id === "modal") { $("#modal").classList.remove("open"); return; }
  if (t.closest("#loadAudit")) return loadAudit();
  const bb = t.closest("#brandBtn"); if (bb) return openBrandMenu(bb);
  const db = t.closest("#dateBtn"); if (db) return openDateMenu(db);
  if (!t.closest(".menu") && !t.closest("#brandBtn") && !t.closest("#dateBtn")) closeMenus();
});

document.addEventListener("change", e => {
  const t = e.target;
  if (t.dataset && t.dataset.chan != null && t.type === "checkbox") {
    const v = t.dataset.chan;
    STATE.channels = t.checked ? [...STATE.channels, v] : STATE.channels.filter(x => x !== v);
    STATE.page = 1; renderMentionList(); return;
  }
  if (t.dataset && t.dataset.sent != null) {
    const v = t.dataset.sent;
    STATE.sentiments = t.checked ? [...STATE.sentiments, v] : STATE.sentiments.filter(x => x !== v);
    STATE.page = 1; renderMentionList(); return;
  }
  if (t.id === "discoveredToggle") { STATE.includeDiscovered = t.checked; STATE.page = 1; return render(); }
  if (t.id === "sortSel") { STATE.sort = t.value; return renderMentionList(); }
  if (t.id === "recOwnerSel") { STATE.recOwner = t.value; return render(); }
});

let openMenu = null;
function closeMenus() { if (openMenu) { openMenu.remove(); openMenu = null; } }
function placeMenu(btn, m) {
  document.body.appendChild(m);
  const r = btn.getBoundingClientRect();
  m.style.top = r.bottom + 6 + "px";
  m.style.right = window.innerWidth - r.right + "px";
  openMenu = m;
}
function openBrandMenu(btn) {
  closeMenus();
  const m = document.createElement("div");
  m.className = "menu";
  m.innerHTML = DATA.meta.brand_order.map(id => {
    const b = DATA.brands[id];
    const n = filtered(id).length;
    return `<button data-brand="${id}" aria-selected="${STATE.brand === id}">${esc(b.name)}
      ${b.primary ? '<span class="badge brand xs">you</span>' : ""}
      <span class="mcount tnum">${n}</span></button>`;
  }).join("");
  m.querySelectorAll("[data-brand]").forEach(b => b.onclick = () => {
    STATE.brand = b.dataset.brand; STATE.channels = []; STATE.sentiments = []; STATE.page = 1;
    // Citation analysis and the metrics row are per-brand, so they must be
    // re-fetched rather than showing the previous brand's numbers.
    window.__d360_ai_loaded = false;
    closeMenus(); render();
  });
  placeMenu(btn, m);
}
function openDateMenu(btn) {
  closeMenus();
  const m = document.createElement("div");
  m.className = "menu";
  const t = DATA.meta.totals || {};
  m.innerHTML = [...DATA.meta.ranges, "all"].map(d => {
    const n = d === "all" ? t.total : (t.ranges && t.ranges[d] ? t.ranges[d].total : 0);
    return `<button data-range="${d}" aria-selected="${String(STATE.range) === String(d)}">${RANGE_LABELS[d]}<span class="mcount tnum">${n}</span></button>`;
  }).join("") + `<div class="mdiv"></div><p class="menunote">Counts are all 7 products combined, dated records only. ${t.undated || 0} undated record(s) sit outside every range.</p>`;
  m.querySelectorAll("[data-range]").forEach(b => b.onclick = () => {
    STATE.range = b.dataset.range === "all" ? "all" : +b.dataset.range;
    STATE.page = 1; closeMenus(); render();
  });
  placeMenu(btn, m);
}

/* theme */
function applyTheme(t) {
  document.documentElement.setAttribute("data-theme", t);
  store.s("d360ci_theme", t);
  $("#themeIcon").innerHTML = t === "dark"
    ? '<circle cx="12" cy="12" r="4.5"/><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"/>'
    : '<path d="M21 12.8A9 9 0 1 1 11.2 3 7 7 0 0 0 21 12.8z"/>';
}
$("#themeBtn").onclick = () => {
  const cur = document.documentElement.getAttribute("data-theme") || (matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light");
  applyTheme(cur === "dark" ? "light" : "dark");
};
window.addEventListener("resize", closeMenus);

/* boot */
async function boot() {
  applyTheme(store.g("d360ci_theme") || "light");
  try {
    DATA = await (await fetch("/api/data")).json();
  } catch (e) {
    $("#views").innerHTML = '<div class="empty big"><h3>Could not reach the data API</h3><p>Start the server with <code>npm start</code>.</p></div>';
    return;
  }
  if (DATA.error) {
    $("#views").innerHTML = `<div class="empty big"><h3>No data built yet</h3><p>${esc(DATA.message)}</p></div>`;
    return;
  }
  try { await window.D360Views.loadWebhook(); } catch (e) { /* settings will show unconfigured */ }
  const i = DATA.meta.integrity;
  $("#foot").innerHTML = `<b>Document360 Competitive Intelligence</b> — self-owned monitoring across ${DATA.meta.brand_order.length} products and ${DATA.meta.channels.length} channels. No third-party monitoring connector.
    Built ${fmtDateTime(DATA.meta.built_at)} from ${i.verified_records} verified records.
    Every mention links to its exact source and carries the excerpt its sentiment was judged from.
    ${i.sentiment_unclassified ? `<b>${i.sentiment_unclassified} record(s) remain unclassified</b> and are excluded from all sentiment figures.` : ""}`;
  render();
}
boot();
