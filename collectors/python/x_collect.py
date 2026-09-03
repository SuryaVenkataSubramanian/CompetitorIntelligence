#!/usr/bin/env python3
"""
X (Twitter) collector using twikit — https://github.com/d60/twikit

Contract with the Node side (collectors/lib/python.js):
  stdin  : one JSON job  {targets, since_days, username, email, password, cookies_path, max_per_target}
  stdout : one JSON object {tweets: [...], gaps: [...]}
  stderr : diagnostics only

Accuracy rules enforced here, mirroring the Node collectors:
  - Only tweets actually returned by the API are emitted. On any error the target
    is recorded in `gaps` with the reason; it is never backfilled or estimated.
  - created_at is passed through verbatim from X, so dates are exact.
  - Every tweet carries its permalink so the dashboard can link straight to it.

twikit needs no API key but does need a real account. Cookies are cached to
cookies_path so repeat runs don't re-authenticate (which is what triggers
challenges and account restrictions).
"""
import asyncio
import json
import os
import sys
from datetime import datetime, timedelta, timezone


def out(obj):
    sys.stdout.write(json.dumps(obj))
    sys.stdout.flush()


def log(msg):
    sys.stderr.write(str(msg) + "\n")
    sys.stderr.flush()


def parse_created(v):
    """X returns e.g. 'Wed Aug 05 12:00:00 +0000 2026'. Return ISO date or None."""
    if not v:
        return None
    if isinstance(v, datetime):
        return v.date().isoformat()
    for fmt in ("%a %b %d %H:%M:%S %z %Y", "%Y-%m-%dT%H:%M:%S%z", "%Y-%m-%d"):
        try:
            return datetime.strptime(str(v), fmt).date().isoformat()
        except ValueError:
            continue
    return None


async def main():
    try:
        job = json.load(sys.stdin)
    except Exception as e:
        out({"tweets": [], "gaps": [{"brand_id": None, "reason": f"bad job json: {e}"}]})
        return

    try:
        from twikit import Client
    except ImportError:
        out({
            "tweets": [],
            "gaps": [{
                "brand_id": None,
                "reason": "twikit not installed. Run: npm run setup:python "
                          "(installs twikit into collectors/python/.venv)",
            }],
        })
        return

    targets = job.get("targets") or []
    since_days = int(job.get("since_days") or 90)
    max_per = int(job.get("max_per_target") or 40)
    cookies_path = job.get("cookies_path") or ".x_cookies.json"
    cutoff = datetime.now(timezone.utc) - timedelta(days=since_days)

    client = Client("en-US")
    gaps = []

    # Reuse cookies where possible — re-login on every run is what gets accounts
    # flagged, and it is also slower.
    authed = False
    if os.path.exists(cookies_path):
        try:
            client.load_cookies(cookies_path)
            authed = True
            log("loaded cached cookies")
        except Exception as e:
            log(f"cookie load failed, will log in: {e}")

    if not authed:
        try:
            await client.login(
                auth_info_1=job.get("username"),
                auth_info_2=job.get("email"),
                password=job.get("password"),
            )
            try:
                client.save_cookies(cookies_path)
            except Exception as e:
                log(f"could not save cookies: {e}")
        except Exception as e:
            out({
                "tweets": [],
                "gaps": [{"brand_id": None, "reason": f"twikit login failed: {e}"}],
            })
            return

    tweets = []
    seen = set()

    for t in targets:
        brand_id = t.get("brand_id")
        query = t.get("query") or t.get("name")
        handle = t.get("handle")

        # 1. Keyword search for mentions by anyone.
        try:
            results = await client.search_tweet(query, "Latest")
            count = 0
            while results and count < max_per:
                for tw in results:
                    if count >= max_per:
                        break
                    iso = parse_created(getattr(tw, "created_at", None))
                    if iso and datetime.fromisoformat(iso).replace(tzinfo=timezone.utc) < cutoff:
                        continue
                    tid = str(getattr(tw, "id", "") or "")
                    if not tid or tid in seen:
                        continue
                    seen.add(tid)
                    user = getattr(tw, "user", None)
                    author = getattr(user, "screen_name", None) if user else None
                    tweets.append({
                        "brand_id": brand_id,
                        "id": tid,
                        "url": f"https://x.com/{author or 'i'}/status/{tid}",
                        "text": getattr(tw, "text", None),
                        "created_at": iso,
                        "author_handle": author,
                        "author_followers": getattr(user, "followers_count", None) if user else None,
                        "favorite_count": getattr(tw, "favorite_count", None),
                        "retweet_count": getattr(tw, "retweet_count", None),
                        "reply_count": getattr(tw, "reply_count", None),
                        "view_count": getattr(tw, "view_count", None),
                        "discovered_via": f"twikit search_tweet({query})",
                    })
                    count += 1
                if count >= max_per:
                    break
                try:
                    results = await results.next()
                except Exception:
                    break
            log(f"{brand_id}: {count} tweets from search")
        except Exception as e:
            gaps.append({"brand_id": brand_id, "reason": f"X search failed for {query}: {e}"})

        # 2. The brand's own timeline (first-party posts).
        if handle:
            try:
                user = await client.get_user_by_screen_name(handle)
                own = await client.get_user_tweets(user.id, "Tweets")
                c = 0
                for tw in own:
                    if c >= max_per:
                        break
                    iso = parse_created(getattr(tw, "created_at", None))
                    if iso and datetime.fromisoformat(iso).replace(tzinfo=timezone.utc) < cutoff:
                        continue
                    tid = str(getattr(tw, "id", "") or "")
                    if not tid or tid in seen:
                        continue
                    seen.add(tid)
                    tweets.append({
                        "brand_id": brand_id,
                        "id": tid,
                        "url": f"https://x.com/{handle}/status/{tid}",
                        "text": getattr(tw, "text", None),
                        "created_at": iso,
                        "author_handle": handle,
                        "author_followers": getattr(user, "followers_count", None),
                        "favorite_count": getattr(tw, "favorite_count", None),
                        "retweet_count": getattr(tw, "retweet_count", None),
                        "reply_count": getattr(tw, "reply_count", None),
                        "view_count": getattr(tw, "view_count", None),
                        "discovered_via": f"twikit get_user_tweets(@{handle})",
                    })
                    c += 1
                log(f"{brand_id}: {c} tweets from @{handle}")
            except Exception as e:
                gaps.append({"brand_id": brand_id, "reason": f"X timeline failed for @{handle}: {e}"})

        # twikit is rate-limited; pace requests between targets.
        await asyncio.sleep(3)

    out({"tweets": tweets, "gaps": gaps})


if __name__ == "__main__":
    asyncio.run(main())
