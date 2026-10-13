// server.js - 81Mailer bulk mailer backend (Resend API)
const express = require('express');
const { Resend } = require('resend');
const cors = require('cors');
const path = require('path');
require('dotenv').config();

const app = express();
const PORT = process.env.PORT || 5000;

app.use(cors());
app.use(express.json({ limit: '30mb' }));
app.use(express.urlencoded({ limit: '30mb', extended: true }));

// ---- Helpers ----
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function getResend() {
  return new Resend(process.env.RESEND_API_KEY || '');
}

function getFrom(fromName) {
  const addr = process.env.MAIL_FROM || 'hello@eiteone.org';
  return fromName ? `"${fromName}" <${addr}>` : addr;
}

// "a@x.com, b@y.com" -> ["a@x.com", "b@y.com"]
function parseAddressList(input) {
  if (!input) return [];
  const arr = Array.isArray(input) ? input : String(input).split(/[,;\n]/);
  const out = [];
  const seen = new Set();
  for (const raw of arr) {
    const email = String(raw || '').trim().replace(/^<|>$/g, '');
    if (!EMAIL_RE.test(email)) continue;
    const k = email.toLowerCase();
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(email);
  }
  return out;
}

// ---- Attachments (Resend: same files sent with every email) ----
// Expected shape from the client: [{ filename, content (base64), contentType? }]
// Limits keep us under Resend's ~40MB/email cap and avoid huge JSON bodies.
const MAX_ATTACHMENTS = 5;
const MAX_FILE_BYTES = 10 * 1024 * 1024; // 10MB per file (decoded)
const MAX_TOTAL_BYTES = 20 * 1024 * 1024; // 20MB total (decoded)

function parseAttachments(input) {
  if (input === undefined || input === null || input === '') return { attachments: [], totalBytes: 0 };
  if (!Array.isArray(input)) throw new Error('attachments must be an array of { filename, content }');
  if (input.length > MAX_ATTACHMENTS) {
    throw new Error(`Too many attachments (${input.length}). Max ${MAX_ATTACHMENTS} files per send.`);
  }
  const attachments = [];
  let totalBytes = 0;
  for (const [idx, file] of input.entries()) {
    const filename = String(file?.filename || '').trim().replace(/[\\/]+/g, '_').slice(0, 255);
    if (!filename) throw new Error(`Attachment #${idx + 1}: filename is required`);
    let content = String(file?.content || '');
    if (!content) throw new Error(`Attachment "${filename}": content is empty`);
    // Accept full data URLs ("data:application/pdf;base64,....") or raw base64.
    const b64 = content.includes(',') && content.includes(';base64') ? content.split(',').pop() : content;
    const clean = b64.replace(/\s+/g, '');
    if (!/^[A-Za-z0-9+/=_-]+$/.test(clean)) {
      throw new Error(`Attachment "${filename}": content must be base64-encoded`);
    }
    let byteLen;
    try {
      byteLen = Buffer.from(clean, 'base64').length;
    } catch {
      throw new Error(`Attachment "${filename}": content is not valid base64`);
    }
    if (byteLen === 0) throw new Error(`Attachment "${filename}": content is empty`);
    if (byteLen > MAX_FILE_BYTES) {
      throw new Error(
        `Attachment "${filename}" is ${(byteLen / 1024 / 1024).toFixed(1)}MB — max ${(MAX_FILE_BYTES / 1024 / 1024).toFixed(0)}MB per file`
      );
    }
    totalBytes += byteLen;
    attachments.push({
      filename,
      content: clean,
      ...(file?.contentType ? { contentType: String(file.contentType).slice(0, 127) } : {}),
    });
  }
  if (totalBytes > MAX_TOTAL_BYTES) {
    throw new Error(
      `Attachments total ${(totalBytes / 1024 / 1024).toFixed(1)}MB — max ${(MAX_TOTAL_BYTES / 1024 / 1024).toFixed(0)}MB per send`
    );
  }
  return { attachments, totalBytes };
}

// Replace {{key}} placeholders with recipient vars (case-insensitive keys).
// e.g. "Hi {{name}}" + { name: 'Ada', email: '...' } -> "Hi Ada"
function renderTemplate(str = '', vars = {}) {
  const lower = {};
  for (const [k, v] of Object.entries(vars)) lower[String(k).toLowerCase()] = v ?? '';
  return String(str).replace(/{{\s*([\w.-]+)\s*}}/g, (_, key) => {
    const val = lower[String(key).toLowerCase()];
    return val !== undefined ? String(val) : '';
  });
}

// ---- Health / config ----
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.get('/api/health', (req, res) => {
  res.json({
    ok: true,
    service: '81Mailer bulk mailer',
    provider: 'resend',
    sender: process.env.MAIL_FROM || null,
    configured: Boolean(process.env.RESEND_API_KEY && process.env.MAIL_FROM),
  });
});

app.get('/api/verify', async (req, res) => {
  if (!process.env.RESEND_API_KEY) {
    return res.status(500).json({ success: false, message: 'RESEND_API_KEY not set in .env' });
  }
  if (!process.env.MAIL_FROM) {
    return res.status(500).json({ success: false, message: 'MAIL_FROM not set in .env (e.g. hello@eiteone.org)' });
  }
  try {
    const { error } = await getResend().domains.list();
    if (error) throw new Error(error.message || JSON.stringify(error));
    res.json({ success: true, message: `Resend ready, sending as ${process.env.MAIL_FROM}` });
  } catch (err) {
    console.error('Resend verify failed:', err);
    res.status(500).json({
      success: false,
      message: 'Resend verification failed. Check RESEND_API_KEY + verified domain. ' + (err.message || err),
    });
  }
});

// ---- Single email (kept for backwards compat) ----
app.post('/api/send-email', async (req, res) => {
  const { name, email, subject, message, cc, attachments: rawAttachments } = req.body;
  if (!subject || !message || !email) {
    return res.status(400).json({ success: false, message: 'email, subject and message are required' });
  }
  const ccList = parseAddressList(cc);
  let attachments = [];
  try {
    ({ attachments } = parseAttachments(rawAttachments));
  } catch (err) {
    return res.status(400).json({ success: false, message: err.message });
  }
  try {
    const { error } = await getResend().emails.send({
      from: getFrom(),
      replyTo: email,
      to: process.env.MAIL_FROM,
      ...(ccList.length ? { cc: ccList } : {}),
      subject,
      text: `From: ${name || 'Unknown'} <${email}>\n\n${message}`,
      ...(attachments.length ? { attachments } : {}),
    });
    if (error) throw new Error(error.message || JSON.stringify(error));
    res.json({ success: true, message: 'Email sent successfully' });
  } catch (err) {
    console.error('Email sending failed:', err);
    res.status(500).json({ success: false, message: 'Failed to send email: ' + (err.message || err) });
  }
});

// ---- Bulk send ----
// Body: {
//   recipients: [{ email, name?, ...customVars }] | ["a@x.com", ...],
//   subject: "Hello {{name}}",
//   text: "Hi {{name}} ..." (optional if html given),
//   html: "<p>Hi {{name}}</p>" (optional),
//   fromName: "Acme" (optional),
//   replyTo: "optional@x.com" (optional),
//   cc: ["cc@x.com"] or "cc@x.com, other@y.com" (optional, applied to every email),
//   attachments: [{ filename, content (base64), contentType? }] (optional, same files for every recipient),
//   delayMs: 500 (optional, default 500 - Resend is fast, small delay is polite)
// }
app.post('/api/send-bulk', async (req, res) => {
  let { recipients, subject, text, html, fromName, replyTo, cc, delayMs, attachments: rawAttachments } = req.body;

  if (!process.env.RESEND_API_KEY || !process.env.MAIL_FROM) {
    return res.status(500).json({
      success: false,
      message: 'Server not configured: set RESEND_API_KEY and MAIL_FROM in .env',
    });
  }
  if (!subject) return res.status(400).json({ success: false, message: 'subject is required' });
  if (!text && !html) return res.status(400).json({ success: false, message: 'Provide a plain-text body and/or HTML body' });
  if (!Array.isArray(recipients) || recipients.length === 0) {
    return res.status(400).json({ success: false, message: 'recipients must be a non-empty array' });
  }
  if (recipients.length > 1000) {
    return res.status(400).json({
      success: false,
      message: `Too many recipients (${recipients.length}). Split into batches of max 1000. Note your Resend plan limits apply (free: 100/day).`,
    });
  }

  // Normalise "a@x.com" -> { email: "a@x.com" }
  recipients = recipients
    .map((r) => (typeof r === 'string' ? { email: r.trim() } : { ...r, email: String(r?.email || '').trim() }))
    .filter((r) => r.email);

  const invalid = recipients.filter((r) => !EMAIL_RE.test(r.email));
  if (invalid.length > 0) {
    return res.status(400).json({
      success: false,
      message: `Invalid email address(es): ${invalid.slice(0, 5).map((r) => r.email).join(', ')}${invalid.length > 5 ? ` (+${invalid.length - 5} more)` : ''}`,
    });
  }

  // Validate CC list (invalid entries rejected loudly so typos don't silently vanish)
  let ccList = [];
  if (cc !== undefined && cc !== null && cc !== '') {
    const rawCc = Array.isArray(cc) ? cc : String(cc).split(/[,;\n]/);
    const bad = rawCc.map((s) => String(s || '').trim()).filter((s) => s && !EMAIL_RE.test(s.replace(/^<|>$/g, '')));
    if (bad.length > 0) {
      return res.status(400).json({
        success: false,
        message: `Invalid CC address(es): ${bad.slice(0, 5).join(', ')}`,
      });
    }
    ccList = parseAddressList(rawCc);
  }

  // De-duplicate recipients (case-insensitive)
  const seen = new Set();
  recipients = recipients.filter((r) => {
    const k = r.email.toLowerCase();
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });

  // Validate attachments once (same files go to every recipient).
  let attachments = [];
  try {
    ({ attachments } = parseAttachments(rawAttachments));
  } catch (err) {
    return res.status(400).json({ success: false, message: err.message });
  }

  delayMs = Math.max(0, Math.min(Number(delayMs ?? 500) || 0, 60000));

  const resend = getResend();
  const from = getFrom(fromName);

  const results = [];
  let sent = 0;
  let failed = 0;

  for (let i = 0; i < recipients.length; i++) {
    const rcpt = recipients[i];
    const vars = { email: rcpt.email, ...rcpt };
    const personalSubject = renderTemplate(subject, vars);
    const personalText = text ? renderTemplate(text, vars) : undefined;
    const personalHtml = html ? renderTemplate(html, vars) : undefined;

    try {
      // One API send per recipient so each gets a personalised copy
      // (and failures don't take down the whole batch).
      const { error } = await resend.emails.send({
        from,
        to: rcpt.name ? `"${rcpt.name}" <${rcpt.email}>` : rcpt.email,
        ...(ccList.length ? { cc: ccList } : {}),
        subject: personalSubject,
        ...(personalText ? { text: personalText } : {}),
        ...(personalHtml ? { html: personalHtml } : {}),
        ...(replyTo ? { replyTo } : {}),
        ...(attachments.length ? { attachments } : {}),
      });
      if (error) throw new Error(error.message || JSON.stringify(error));
      sent++;
      results.push({ email: rcpt.email, status: 'sent' });
    } catch (err) {
      failed++;
      console.error(`Bulk send failed for ${rcpt.email}:`, err.message);
      results.push({ email: rcpt.email, status: 'failed', error: err.message || String(err) });
      // Resend rate limits come back as 429 — back off extra before continuing.
      if (/429|rate|limit|quota|too many/i.test(err.message || '')) {
        await sleep(10000);
      }
    }

    if (i < recipients.length - 1 && delayMs > 0) await sleep(delayMs);
  }

  res.json({
    success: failed === 0,
    message: `Bulk send finished: ${sent} sent, ${failed} failed out of ${recipients.length}`,
    summary: { total: recipients.length, sent, failed },
    results,
  });
});

// Serve frontend
app.use(express.static(path.join(__dirname, 'public')));

app.listen(PORT, () => console.log(`81Mailer bulk mailer running on port ${PORT} via Resend`));
