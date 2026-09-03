"""
Minimal `pwd` shim so SearXNG can run on Windows.

WHY THIS IS SAFE, AND WHY IT IS THIS SMALL
------------------------------------------
`pwd` is the POSIX user-account database module. It does not exist on Windows, and
`searx/webapp.py` -> `searx/limiter.py` -> `searx/valkeydb.py` imports it at module
level, so SearXNG cannot even start without it.

An audit of the whole `searx/` tree found `pwd` imported in exactly one file and
used on exactly one line:

    searx/valkeydb.py:63
        _pw = pwd.getpwuid(os.getuid())
        logger.exception("[%s (%s)] can't connect valkey DB ...", _pw.pw_name, _pw.pw_uid)

That is a diagnostic log line reached only when a Valkey/Redis connection fails.
This deployment configures no Valkey at all (`limiter: false`), so the line is
unreachable in practice. The shim exists purely to satisfy the import.

It deliberately does NOT emulate a real user database. It reports the actual
Windows username for log fidelity and a fixed synthetic uid, because nothing in
SearXNG makes an authorisation decision from these values — it only formats them
into a message.

Loaded via PYTHONPATH by collectors/searxng/run-local.js, so neither the venv nor
the vendored SearXNG checkout is modified and `git pull` in vendor/searxng stays
clean.
"""

import os
from collections import namedtuple

# Mirrors the real pwd.struct_passwd field order.
struct_passwd = namedtuple(
    "struct_passwd",
    ["pw_name", "pw_passwd", "pw_uid", "pw_gid", "pw_gecos", "pw_dir", "pw_shell"],
)

# Windows has no uid concept. A fixed synthetic value is honest here: it is never
# compared, persisted, or used for access control — only logged.
_SYNTHETIC_UID = 0
_SYNTHETIC_GID = 0


def _current():
    name = (
        os.environ.get("USERNAME")
        or os.environ.get("USER")
        or "unknown"
    )
    return struct_passwd(
        pw_name=name,
        pw_passwd="x",
        pw_uid=_SYNTHETIC_UID,
        pw_gid=_SYNTHETIC_GID,
        pw_gecos=name,
        pw_dir=os.environ.get("USERPROFILE", ""),
        pw_shell="",
    )


def getpwuid(uid=None):
    """Return the current user regardless of uid — there is only one here."""
    return _current()


def getpwnam(name):
    rec = _current()
    if name and name != rec.pw_name:
        # Match the real module's contract rather than inventing a user.
        raise KeyError("getpwnam(): name not found: %r" % (name,))
    return rec


def getpwall():
    return [_current()]


# `pwd.getpwuid(os.getuid())` needs os.getuid, which Windows also lacks. Provide
# it only if genuinely absent, so this is a no-op on any POSIX host.
if not hasattr(os, "getuid"):
    os.getuid = lambda: _SYNTHETIC_UID  # type: ignore[attr-defined]
if not hasattr(os, "getgid"):
    os.getgid = lambda: _SYNTHETIC_GID  # type: ignore[attr-defined]
