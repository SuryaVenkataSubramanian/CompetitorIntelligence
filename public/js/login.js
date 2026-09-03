/**
 * Login form. Posts to /api/login, which sets an HttpOnly session cookie —
 * deliberately unreadable from script, so no token is ever handled here.
 */
(function () {
  const form = document.getElementById("loginForm");
  const msg = document.getElementById("msg");
  const btn = document.getElementById("submitBtn");

  function show(text, kind) {
    msg.textContent = text;
    msg.className = "login-msg " + (kind || "");
  }

  form.addEventListener("submit", async e => {
    e.preventDefault();
    const email = document.getElementById("email").value.trim();
    const password = document.getElementById("password").value;

    if (!email || !password) {
      show("Enter your email and password.", "err");
      return;
    }

    btn.disabled = true;
    btn.textContent = "Signing in…";
    show("");

    try {
      const r = await fetch("/api/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email, password }),
      });
      const j = await r.json().catch(() => ({}));
      if (r.ok && j.ok) {
        show("Signed in. Loading dashboard…", "ok");
        // Replace so the login page does not sit in history behind the dashboard.
        window.location.replace("/");
        return;
      }
      show(j.error || "Sign in failed.", "err");
    } catch (err) {
      show("Could not reach the server. Is it running?", "err");
    } finally {
      btn.disabled = false;
      btn.textContent = "Sign in";
    }
  });
})();
