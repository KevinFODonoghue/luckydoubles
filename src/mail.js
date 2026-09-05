// Transactional email via Brevo (https://brevo.com) — free tier, and it will
// send from a single verified address, so the league does not need to own a
// domain. Plain fetch rather than an SDK: it's one POST, and this app
// deliberately carries few dependencies.
//
// Swapping providers means rewriting `deliver` and `isConfigured` and nothing
// else; the rest of the app only knows about `send`.
//
// Unconfigured is a normal state, not an error. Without the env vars below the
// app still runs and password resets fall back to the admin queue (auth.js).
//
//   BREVO_API_KEY   from Brevo → SMTP & API → API keys
//   MAIL_FROM       e.g. "Blind Doubles <league@gmail.com>" — the address must
//                   be verified in Brevo → Senders first, or Brevo rejects it
//   APP_URL         public origin used to build links, e.g.
//                   https://luckydoubles.vercel.app

const BREVO_ENDPOINT = 'https://api.brevo.com/v3/smtp/email';

// "Name <a@b.com>" or a bare "a@b.com".
function parseFrom(value) {
  const raw = String(value || '').trim();
  if (!raw) return null;
  const match = /^\s*(.*?)\s*<\s*([^<>\s]+@[^<>\s]+)\s*>\s*$/.exec(raw);
  if (match) return { name: match[1].replace(/^"|"$/g, '') || 'Blind Doubles', email: match[2] };
  if (/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(raw)) return { name: 'Blind Doubles', email: raw };
  return null;
}

function sender() {
  return parseFrom(process.env.MAIL_FROM);
}

function isConfigured() {
  return Boolean(process.env.BREVO_API_KEY) && Boolean(sender());
}

// Why email can't be sent right now, in words an admin can act on.
function configProblem() {
  if (!process.env.BREVO_API_KEY) return 'BREVO_API_KEY is not set';
  if (!process.env.MAIL_FROM) return 'MAIL_FROM is not set';
  if (!sender()) return `MAIL_FROM ("${process.env.MAIL_FROM}") is not a valid address`;
  return null;
}

// The public origin used to build links in emails. Deliberately not taken from
// the request Host header by default: a forged host would email bowlers a reset
// link pointing at someone else's site.
function appOrigin(req) {
  if (process.env.APP_URL) return String(process.env.APP_URL).replace(/\/+$/, '');
  if (process.env.VERCEL_PROJECT_PRODUCTION_URL) return 'https://' + process.env.VERCEL_PROJECT_PRODUCTION_URL;
  return `${req.protocol}://${req.get('host')}`;
}

async function deliver({ to, toName, subject, text, html }) {
  const res = await fetch(BREVO_ENDPOINT, {
    method: 'POST',
    headers: {
      'api-key': process.env.BREVO_API_KEY,
      'content-type': 'application/json',
      accept: 'application/json',
    },
    body: JSON.stringify({
      sender: sender(),
      to: [toName ? { email: to, name: toName } : { email: to }],
      subject,
      textContent: text,
      htmlContent: html,
    }),
    signal: AbortSignal.timeout(10000),
  });
  if (!res.ok) {
    const detail = await res.text().catch(() => '');
    return { ok: false, reason: `Brevo responded ${res.status}: ${detail.slice(0, 300)}` };
  }
  const body = await res.json().catch(() => ({}));
  return { ok: true, id: body.messageId };
}

async function send(message) {
  const problem = configProblem();
  if (problem) return { ok: false, reason: problem };
  try {
    return await deliver(message);
  } catch (e) {
    return { ok: false, reason: e.name === 'TimeoutError' ? 'Brevo timed out' : e.message };
  }
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
  ));
}

// The reset email. Deliberately plain: one sentence, one button, one fallback
// URL — it survives every mail client and reads as legitimate rather than spam.
function resetEmail({ name, link, minutes }) {
  const safeName = escapeHtml(name);
  const safeLink = escapeHtml(link);
  return {
    subject: 'Reset your Blind Doubles password',
    text: [
      `Hi ${name},`,
      '',
      'Someone asked to reset the password on your Blind Doubles account.',
      `Open this link to choose a new one — it expires in ${minutes} minutes:`,
      '',
      link,
      '',
      "If that wasn't you, ignore this email. Your password stays as it is.",
      '',
      '🎳 Friday Night Blind Doubles',
    ].join('\n'),
    html: `
<div style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;max-width:520px;margin:0 auto;padding:24px;color:#1a1d23;line-height:1.5">
  <p style="font-size:22px;font-weight:700;margin:0 0 20px">🎳 Blind Doubles</p>
  <p style="margin:0 0 12px">Hi ${safeName},</p>
  <p style="margin:0 0 20px">Someone asked to reset the password on your Blind Doubles account. Pick a new one here:</p>
  <p style="margin:0 0 20px">
    <a href="${safeLink}" style="display:inline-block;background:#f5a524;color:#201503;font-weight:600;padding:12px 22px;border-radius:8px;text-decoration:none">Choose a new password</a>
  </p>
  <p style="margin:0 0 20px;color:#5c6779;font-size:14px">This link expires in ${minutes} minutes and can only be used once.</p>
  <p style="margin:0 0 20px;color:#5c6779;font-size:14px">If the button doesn't work, paste this into your browser:<br>
    <span style="word-break:break-all">${safeLink}</span></p>
  <p style="margin:0;color:#5c6779;font-size:14px">If that wasn't you, ignore this email — your password stays as it is.</p>
</div>`.trim(),
  };
}

module.exports = { isConfigured, configProblem, send, appOrigin, resetEmail, parseFrom, sender };
