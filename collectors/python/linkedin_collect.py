#!/usr/bin/env python3
"""
LinkedIn collector using linkedin_scraper — https://github.com/joeyism/linkedin_scraper

Contract with the Node side (collectors/lib/python.js):
  stdin  : one JSON job  {mode, targets, since_days, li_at, max_posts_per_company}
  stdout : one JSON object {posts: [...], gaps: [...]}
  stderr : diagnostics only

Why CompanyPostsScraper: of everything the library exposes, company posts are the
only surface that answers "who is saying what about this product". PersonScraper /
JobSearchScraper are profile and hiring data, not mentions, so they are not used
for the mention feed. (The Node repo josephlimtech/linkedin-profile-scraper-api
covers profile enrichment separately, and is likewise not a mention source.)

Accuracy rules:
  - Only posts the scraper actually returned are emitted; failures go to `gaps`.
  - A post with no resolvable permalink is skipped, because the dashboard
    promises a working hyperlink for every row.
  - Dates come from LinkedIn's own timestamp where exposed. LinkedIn frequently
    shows only relative ages ("2w"); those are converted from the run date and
    marked so, and if no age is available the date is left null rather than
    guessed — a null date keeps the row out of every date-range metric.

linkedin_scraper v3+ is async and Playwright-based, so this uses asyncio and
requires `playwright install chromium`.
"""
import asyncio
import json
import re
import sys
from datetime import datetime, timedelta, timezone


def out(obj):
    sys.stdout.write(json.dumps(obj))
    sys.stdout.flush()


def log(msg):
    sys.stderr.write(str(msg) + "\n")
    sys.stderr.flush()


REL = re.compile(r"(\d+)\s*(minute|hour|day|week|month|year|m|h|d|w|mo|y)s?\b", re.I)


def relative_to_iso(text, now):
    """Convert '2w' / '3 days ago' to an ISO date. Returns (iso, method) or (None, None)."""
    if not text:
        return None, None
    m = REL.search(str(text))
    if not m:
        return None, None
    n = int(m.group(1))
    unit = m.group(2).lower()
    delta = {
        "minute": timedelta(minutes=n), "m": timedelta(minutes=n),
        "hour": timedelta(hours=n), "h": timedelta(hours=n),
        "day": timedelta(days=n), "d": timedelta(days=n),
        "week": timedelta(weeks=n), "w": timedelta(weeks=n),
        "month": timedelta(days=30 * n), "mo": timedelta(days=30 * n),
        "year": timedelta(days=365 * n), "y": timedelta(days=365 * n),
    }.get(unit)
    if not delta:
        return None, None
    return (now - delta).date().isoformat(), f"linkedin:relative({m.group(0)})"


async def main():
    try:
        job = json.load(sys.stdin)
    except Exception as e:
        out({"posts": [], "gaps": [{"brand_id": None, "reason": f"bad job json: {e}"}]})
        return

    try:
        from linkedin_scraper import BrowserManager, CompanyPostsScraper
    except ImportError as e:
        out({
            "posts": [],
            "gaps": [{
                "brand_id": None,
                "reason": "linkedin-scraper not installed or too old (need v3+ with CompanyPostsScraper). "
                          f"Run: npm run setup:python  [{e}]",
            }],
        })
        return

    targets = job.get("targets") or []
    since_days = int(job.get("since_days") or 90)
    max_posts = int(job.get("max_posts_per_company") or 40)
    li_at = job.get("li_at")
    now = datetime.now(timezone.utc)
    cutoff = now - timedelta(days=since_days)

    if not li_at:
        out({"posts": [], "gaps": [{"brand_id": None, "reason": "no li_at cookie supplied"}]})
        return

    posts = []
    gaps = []

    try:
        async with BrowserManager(headless=True) as browser:
            # Inject the session cookie rather than logging in with a password:
            # password login is what triggers checkpoints most often.
            try:
                await browser.page.context.add_cookies([{
                    "name": "li_at",
                    "value": li_at,
                    "domain": ".linkedin.com",
                    "path": "/",
                    "httpOnly": True,
                    "secure": True,
                }])
            except Exception as e:
                out({"posts": [], "gaps": [{"brand_id": None, "reason": f"could not set li_at cookie: {e}"}]})
                return

            scraper = CompanyPostsScraper(browser.page)

            for t in targets:
                brand_id = t.get("brand_id")
                slug = t.get("slug")
                if not slug:
                    continue
                url = f"https://www.linkedin.com/company/{slug}/posts/"
                try:
                    result = await scraper.scrape(url, max_posts=max_posts)
                except TypeError:
                    # Older/newer signature without max_posts.
                    try:
                        result = await scraper.scrape(url)
                    except Exception as e:
                        gaps.append({"brand_id": brand_id, "reason": f"LinkedIn scrape failed for {slug}: {e}"})
                        continue
                except Exception as e:
                    gaps.append({"brand_id": brand_id, "reason": f"LinkedIn scrape failed for {slug}: {e}"})
                    continue

                raw_posts = getattr(result, "posts", None) or (result if isinstance(result, list) else [])
                kept = 0
                for p in raw_posts:
                    def g(*names):
                        for n in names:
                            v = p.get(n) if isinstance(p, dict) else getattr(p, n, None)
                            if v not in (None, ""):
                                return v
                        return None

                    permalink = g("url", "post_url", "link", "permalink")
                    if not permalink:
                        # No link means the dashboard could not route to it; skip.
                        continue

                    iso = None
                    method = None
                    explicit = g("posted_at", "date", "published_at", "timestamp")
                    if explicit:
                        try:
                            iso = datetime.fromisoformat(str(explicit).replace("Z", "+00:00")).date().isoformat()
                            method = "linkedin:timestamp"
                        except Exception:
                            iso, method = relative_to_iso(explicit, now)
                    if not iso:
                        iso, method = relative_to_iso(g("age", "posted", "relative_time"), now)

                    if iso:
                        try:
                            if datetime.fromisoformat(iso).replace(tzinfo=timezone.utc) < cutoff:
                                continue
                        except Exception:
                            pass

                    posts.append({
                        "brand_id": brand_id,
                        "company_slug": slug,
                        "url": str(permalink),
                        "text": g("text", "content", "body", "description"),
                        "title": g("title", "headline"),
                        "posted_at": iso,
                        "date_method": method,
                        "author": g("author", "author_name", "poster"),
                        "reactions": g("reactions", "num_reactions", "likes"),
                        "comments": g("comments", "num_comments"),
                        "reposts": g("reposts", "num_shares", "shares"),
                    })
                    kept += 1

                log(f"{brand_id}: {kept} LinkedIn posts from {slug}")
                # Pace requests — LinkedIn restricts accounts that burst.
                await asyncio.sleep(6)
    except Exception as e:
        gaps.append({"brand_id": None, "reason": f"browser/session failure: {e}"})

    out({"posts": posts, "gaps": gaps})


if __name__ == "__main__":
    asyncio.run(main())
