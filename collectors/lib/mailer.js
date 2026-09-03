/**
 * Minimal SMTP client. This project has no npm dependencies, so no nodemailer.
 *
 * Supports the two configurations that cover essentially every provider:
 *   port 465          implicit TLS from the first byte
 *   port 587 / 25     plaintext connect, then STARTTLS upgrade
 * with AUTH PLAIN or AUTH LOGIN.
 *
 * WHAT HAPPENS WITH NO CREDENTIALS
 * --------------------------------
 * `configured()` returns false and `send()` refuses with a precise description
 * of what is missing. The daily digest still runs and is still stored — it is
 * simply not delivered, and the dashboard says so. That is the honest behaviour:
 * silently discarding a report, or claiming it was sent, would both be worse
 * than an explicit "generated but not emailed".
 *
 * TLS certificates are verified. `rejectUnauthorized: false` would make the
 * common "self-signed relay" case work at the cost of making the credentials
 * interceptable, which is not a trade worth making for a digest email.
 */
const net = require("net");
const tls = require("tls");
const crypto = require("crypto");

function cfg() {
  return {
    host: process.env.SMTP_HOST || "",
    port: parseInt(process.env.SMTP_PORT || "587", 10),
    user: process.env.SMTP_USER || "",
    pass: process.env.SMTP_PASS || "",
    from: process.env.SMTP_FROM || process.env.SMTP_USER || "",
    to: process.env.DIGEST_TO || "",
  };
}

/** Is email delivery usable right now, and if not, exactly what is missing? */
function status() {
  const c = cfg();
  const missing = [];
  if (!c.host) missing.push("SMTP_HOST");
  if (!c.user) missing.push("SMTP_USER");
  if (!c.pass) missing.push("SMTP_PASS");
  if (!c.from) missing.push("SMTP_FROM (or SMTP_USER)");
  if (!c.to) missing.push("DIGEST_TO");
  return {
    configured: missing.length === 0,
    missing,
    host: c.host || null,
    port: c.port,
    // Never the password, and only the local part of the user.
    user_hint: c.user ? c.user.replace(/(.{2}).*(@.*)/, "$1***$2") : null,
    to: c.to || null,
    requirement: missing.length
      ? `Email delivery is NOT configured. Add ${missing.join(", ")} to .env. ` +
        `For Microsoft 365 use SMTP_HOST=smtp.office365.com SMTP_PORT=587 with an account that has SMTP AUTH enabled; ` +
        `for Google Workspace use smtp.gmail.com:587 with an App Password. ` +
        `Until then each digest is generated and stored under data/digests/ but not delivered.`
      : null,
  };
}

function configured() {
  return status().configured;
}

/* ------------------------------------------------------------- SMTP dialogue */

/**
 * One SMTP conversation. Written as an explicit state machine over the socket
 * because the protocol is strictly request/response and a promise-per-command
 * keeps the error reporting precise about which command failed.
 */
function smtpSend({ host, port, user, pass, from, to, subject, text, html }) {
  return new Promise((resolve, reject) => {
    let socket;
    let buffer = "";
    let stage = "greet";
    let upgraded = false;
    let finished = false;
    const log = [];

    const fail = msg => {
      if (finished) return;
      finished = true;
      try { socket && socket.destroy(); } catch (e) { /* already gone */ }
      reject(new Error(msg + (log.length ? ` (last: ${log[log.length - 1]})` : "")));
    };
    const done = () => {
      if (finished) return;
      finished = true;
      try { socket.end("QUIT\r\n"); } catch (e) { /* best effort */ }
      resolve({ ok: true, log });
    };

    const write = line => {
      log.push("> " + (/^AUTH|^[A-Za-z0-9+/=]{16,}$/.test(line) ? "[credentials redacted]" : line));
      socket.write(line + "\r\n");
    };

    const onLine = line => {
      log.push("< " + line);
      const code = parseInt(line.slice(0, 3), 10);
      // Multi-line responses continue while the 4th char is '-'.
      if (line[3] === "-") return;

      switch (stage) {
        case "greet":
          if (code !== 220) return fail("unexpected greeting: " + line);
          stage = "ehlo";
          return write("EHLO d360-competitive-intel");

        case "ehlo":
          if (code !== 250) return fail("EHLO refused: " + line);
          if (!upgraded && port !== 465) {
            stage = "starttls";
            return write("STARTTLS");
          }
          stage = "auth";
          return write("AUTH LOGIN");

        case "starttls":
          if (code !== 220) return fail("server refused STARTTLS: " + line);
          // Re-wrap the live socket in TLS, then start the dialogue again.
          socket.removeAllListeners("data");
          socket = tls.connect({ socket, servername: host }, () => {
            upgraded = true;
            stage = "ehlo";
            write("EHLO d360-competitive-intel");
          });
          socket.on("data", onData);
          socket.on("error", e => fail("TLS error: " + e.message));
          return;

        case "auth":
          if (code !== 334) return fail("AUTH LOGIN refused: " + line);
          stage = "auth_user";
          return write(Buffer.from(user).toString("base64"));

        case "auth_user":
          if (code !== 334) return fail("username rejected: " + line);
          stage = "auth_pass";
          return write(Buffer.from(pass).toString("base64"));

        case "auth_pass":
          if (code !== 235) return fail("authentication failed: " + line);
          stage = "from";
          return write(`MAIL FROM:<${from}>`);

        case "from":
          if (code !== 250) return fail("MAIL FROM refused: " + line);
          stage = "to";
          return write(`RCPT TO:<${to}>`);

        case "to":
          if (code !== 250 && code !== 251) return fail("RCPT TO refused: " + line);
          stage = "data";
          return write("DATA");

        case "data":
          if (code !== 354) return fail("DATA refused: " + line);
          stage = "body";
          return socket.write(buildMessage({ from, to, subject, text, html }) + "\r\n.\r\n");

        case "body":
          if (code !== 250) return fail("message rejected: " + line);
          return done();

        default:
          return fail("unexpected state " + stage);
      }
    };

    const onData = chunk => {
      buffer += chunk.toString("utf8");
      let i;
      while ((i = buffer.indexOf("\r\n")) !== -1) {
        const line = buffer.slice(0, i);
        buffer = buffer.slice(i + 2);
        if (line) onLine(line);
      }
    };

    const opts = { host, port, servername: host };
    socket = port === 465 ? tls.connect(opts) : net.connect({ host, port });
    upgraded = port === 465;
    socket.setTimeout(30000);
    socket.on("data", onData);
    socket.on("timeout", () => fail("SMTP timeout"));
    socket.on("error", e => fail("socket error: " + e.message));
  });
}

/** RFC 5322 message with a MIME alternative body. */
function buildMessage({ from, to, subject, text, html }) {
  const boundary = "b_" + crypto.randomBytes(12).toString("hex");
  const headers = [
    `From: Document360 Competitive Intel <${from}>`,
    `To: <${to}>`,
    // Encode the subject so a non-ASCII character cannot corrupt the header.
    `Subject: =?UTF-8?B?${Buffer.from(String(subject)).toString("base64")}?=`,
    `Date: ${new Date().toUTCString()}`,
    `Message-ID: <${crypto.randomBytes(16).toString("hex")}@d360-competitive-intel>`,
    "MIME-Version: 1.0",
    `Content-Type: multipart/alternative; boundary="${boundary}"`,
  ];

  // Dot-stuffing: a line consisting of a single "." would otherwise terminate
  // the DATA block early and truncate the message.
  const stuff = s => String(s).replace(/\r?\n/g, "\r\n").replace(/^\./gm, "..");

  const body = [
    `--${boundary}`,
    "Content-Type: text/plain; charset=UTF-8",
    "Content-Transfer-Encoding: 8bit",
    "",
    stuff(text || ""),
    "",
    `--${boundary}`,
    "Content-Type: text/html; charset=UTF-8",
    "Content-Transfer-Encoding: 8bit",
    "",
    stuff(html || `<pre>${text || ""}</pre>`),
    "",
    `--${boundary}--`,
  ].join("\r\n");

  return headers.join("\r\n") + "\r\n\r\n" + body;
}

/**
 * Send one message. Returns { ok, ... } and never throws, so a delivery failure
 * cannot take down the job that produced the report.
 */
async function send({ subject, text, html, to = null }) {
  const st = status();
  if (!st.configured) {
    return { ok: false, delivered: false, reason: st.requirement, missing: st.missing };
  }
  const c = cfg();
  const recipient = to || c.to;
  try {
    const r = await smtpSend({
      host: c.host, port: c.port, user: c.user, pass: c.pass,
      from: c.from, to: recipient, subject, text, html,
    });
    return { ok: true, delivered: true, to: recipient, at: new Date().toISOString(), transcript: r.log };
  } catch (e) {
    return { ok: false, delivered: false, to: recipient, error: String(e.message || e), at: new Date().toISOString() };
  }
}

module.exports = { send, status, configured, buildMessage };
