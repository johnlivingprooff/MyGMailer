// public/app.js — 81Mailer bulk mailer frontend logic
const $ = (id) => document.getElementById(id);
const state = { recipients: [], lastResults: [], activeTab: 'text', attachments: [], view: 'compose' };
const analytics = { sendsOffset: 0, sendsTotal: 0, loading: false };
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const MAX_ATTACHMENTS = 5;
const MAX_FILE_BYTES = 10 * 1024 * 1024;
const MAX_TOTAL_BYTES = 20 * 1024 * 1024;

// Inline SVG status icons (stroke = currentColor, coloured via CSS per row)
const svgWrap = (inner, cls = '') =>
  `<svg class="${cls}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${inner}</svg>`;
const ICONS = {
  sent: svgWrap('<circle cx="12" cy="12" r="10"/><path d="m9 12 2 2 4-4"/>'),
  failed: svgWrap('<circle cx="12" cy="12" r="10"/><path d="m15 9-6 6"/><path d="m9 9 6 6"/>'),
  pending: svgWrap('<circle cx="12" cy="12" r="10"/><path d="M12 6v6l4 2"/>'),
  info: svgWrap('<circle cx="12" cy="12" r="10"/><path d="M12 16v-4"/><path d="M12 8h.01"/>'),
};
const ICON_X = svgWrap('<path d="M18 6 6 18"/><path d="m6 6 12 12"/>');
const ICON_SEND = svgWrap('<path d="m22 2-7 20-4-9-9-4Z"/><path d="M22 2 11 13"/>');
const ICON_LOADER = svgWrap('<path d="M21 12a9 9 0 1 1-6.219-8.56"/>', 'spin');

// ---------- Tabs ----------
document.querySelectorAll('.tab').forEach((btn) => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('.tab').forEach((b) => b.classList.remove('active'));
    btn.classList.add('active');
    state.activeTab = btn.dataset.tab;
    $('bodyText').classList.toggle('hidden', state.activeTab !== 'text');
    $('bodyHtml').classList.toggle('hidden', state.activeTab !== 'html');
  });
});

// Insert {{var}} chips at cursor
document.querySelectorAll('.chip').forEach((chip) => {
  chip.addEventListener('click', () => {
    const target = state.activeTab === 'html' ? $('bodyHtml') : $('bodyText');
    const ins = chip.dataset.insert + ' ';
    const s = target.selectionStart ?? target.value.length;
    target.value = target.value.slice(0, s) + ins + target.value.slice(target.selectionEnd ?? s);
    target.focus();
    updatePreview();
  });
});

// ---------- Recipients ----------
function normaliseEmail(e) { return String(e || '').trim(); }

function upsertRecipient(email, extra = {}) {
  email = normaliseEmail(email);
  if (!EMAIL_RE.test(email)) return { ok: false, reason: 'invalid' };
  const key = email.toLowerCase();
  const existing = state.recipients.find((r) => r.email.toLowerCase() === key);
  if (existing) { Object.assign(existing, extra); return { ok: false, reason: 'duplicate' }; }
  state.recipients.push({ email, ...extra });
  return { ok: true };
}

function renderRecipients() {
  const body = $('recipBody');
  body.innerHTML = '';
  if (state.recipients.length === 0) {
    body.innerHTML = '<tr class="empty"><td colspan="3">No recipients yet — add, paste or upload a CSV.</td></tr>';
  }
  state.recipients.forEach((r, i) => {
    const tr = document.createElement('tr');
    const extraKeys = Object.keys(r).filter((k) => !['email', 'name'].includes(k));
    tr.innerHTML =
      `<td><strong>${escapeHtml(r.email)}</strong></td>` +
      `<td>${escapeHtml(r.name || '')}${extraKeys.length ? `<div class="vars">${extraKeys.map((k) => `${escapeHtml(k)}=${escapeHtml(String(r[k]))}`).join(' · ')}</div>` : ''}</td>` +
      `<td><button class="rm" data-i="${i}" title="Remove">${ICON_X}</button></td>`;
    body.appendChild(tr);
  });
  body.querySelectorAll('.rm').forEach((b) =>
    b.addEventListener('click', () => { state.recipients.splice(Number(b.dataset.i), 1); renderRecipients(); updateEstimates(); updatePreview(); })
  );
  $('countBadge').textContent = state.recipients.length;
  updateEstimates();
  updatePreview();
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

$('addBtn').addEventListener('click', () => {
  const email = $('manualEmail').value, name = $('manualName').value.trim();
  const r = upsertRecipient(email, name ? { name } : {});
  if (!r.ok) return toast(`Not added (${r.reason}): ${email}`, false);
  $('manualEmail').value = ''; $('manualName').value = '';
  renderRecipients();
});

$('importPasteBtn').addEventListener('click', () => {
  const lines = $('pasteBox').value.split(/\r?\n/);
  let added = 0, skipped = 0;
  for (const line of lines) {
    if (!line.trim()) continue;
    // support "email, name" or "email;name" or just "email"
    const parts = line.split(/[,;\t]/).map((s) => s.trim()).filter(Boolean);
    if (!parts.length) continue;
    const email = parts[0].replace(/^<|>$/g, '');
    const extra = parts[1] ? { name: parts[1] } : {};
    const r = upsertRecipient(email, extra);
    r.ok ? added++ : skipped++;
  }
  $('pasteBox').value = '';
  toast(`Imported ${added}, skipped ${skipped}`, added > 0);
  renderRecipients();
});

$('csvFile').addEventListener('change', (e) => {
  const file = e.target.files[0];
  if (!file) return;
  const reader = new FileReader();
  reader.onload = () => {
    const { added, skipped } = importCsvText(String(reader.result || ''));
    toast(`CSV: ${added} added, ${skipped} skipped`, added > 0);
    renderRecipients();
  };
  reader.readAsText(file);
  e.target.value = '';
});

// Minimal CSV parser (handles quoted commas)
function parseCsv(text) {
  const rows = [];
  let row = [], cell = '', inQuotes = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i], n = text[i + 1];
    if (c === '"' && inQuotes && n === '"') { cell += '"'; i++; }
    else if (c === '"') inQuotes = !inQuotes;
    else if ((c === '\n' || c === '\r') && !inQuotes) {
      if (cell !== '' || row.length) { row.push(cell); rows.push(row); row = []; cell = ''; }
      if (c === '\r' && n === '\n') i++;
    }
    else if (c === ',' && !inQuotes) { row.push(cell); cell = ''; }
    else cell += c;
  }
  if (cell !== '' || row.length) { row.push(cell); rows.push(row); }
  return rows.map((r) => r.map((s) => s.trim()));
}

function importCsvText(text) {
  const rows = parseCsv(text).filter((r) => r.some((c) => c !== ''));
  if (!rows.length) return { added: 0, skipped: 0 };
  let added = 0, skipped = 0;
  // Detect header: first row contains "email" word and no @-address in first cell
  const first = rows[0].map((c) => c.toLowerCase());
  const hasHeader = first.includes('email') || first.includes('e-mail') || first.includes('mail');
  const headers = hasHeader ? rows[0].map((c) => c.toLowerCase().replace(/[^a-z0-9]+/g, '')) : null;
  const dataRows = hasHeader ? rows.slice(1) : rows;
  const emailIdx = headers ? headers.findIndex((h) => ['email', 'mail', 'emailaddress'].includes(h)) : 0;
  const nameIdx = headers ? headers.findIndex((h) => ['name', 'fullname', 'firstname'].includes(h)) : 1;

  for (const row of dataRows) {
    const email = normaliseEmail(row[emailIdx >= 0 ? emailIdx : 0]);
    if (!EMAIL_RE.test(email)) { skipped++; continue; }
    const extra = {};
    if (headers) {
      headers.forEach((h, i) => {
        if (i === emailIdx || !row[i]) return;
        extra[headers[i] === 'name' || i === nameIdx ? 'name' : headers[i] || `col${i}`] = row[i];
      });
    } else if (row[1]) extra.name = row[1];
    const r = upsertRecipient(email, extra);
    r.ok ? added++ : skipped++;
  }
  return { added, skipped };
}

$('clearBtn').addEventListener('click', () => { state.recipients = []; renderRecipients(); });
$('sampleBtn').addEventListener('click', () => {
  upsertRecipient('ada@example.com', { name: 'Ada', company: 'Analytical Engines' });
  upsertRecipient('grace@example.com', { name: 'Grace', company: 'Navy Computing' });
  renderRecipients();
});

// ---------- Attachments (same files for every recipient) ----------
function formatBytes(n) {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

function attachmentTotalBytes() {
  return state.attachments.reduce((s, a) => s + (a.size || 0), 0);
}

function renderAttachments() {
  const list = $('attachList');
  list.innerHTML = '';
  state.attachments.forEach((a, i) => {
    const row = document.createElement('div');
    row.className = 'attach-row';
    row.innerHTML =
      `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m21.44 11.05-9.19 9.19a6 6 0 0 1-8.49-8.49l8.57-8.57A4 4 0 1 1 18 8.84l-8.59 8.57a2 2 0 0 1-2.83-2.83l8.49-8.48"/></svg>` +
      `<span class="attach-name">${escapeHtml(a.filename)}</span>` +
      `<span class="muted small">${escapeHtml(formatBytes(a.size || 0))}</span>` +
      `<button class="rm" data-i="${i}" title="Remove attachment">${ICON_X}</button>`;
    list.appendChild(row);
  });
  list.querySelectorAll('.rm').forEach((b) =>
    b.addEventListener('click', () => { state.attachments.splice(Number(b.dataset.i), 1); renderAttachments(); updatePreview(); })
  );
  const total = attachmentTotalBytes();
  $('attachTotal').textContent = state.attachments.length
    ? `${state.attachments.length} file(s) · ${formatBytes(total)} total — sent with every email`
    : '';
  $('clearAttachBtn').classList.toggle('hidden', state.attachments.length === 0);
  updatePreview();
}

function readFileAsBase64(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const dataUrl = String(reader.result || '');
      const base64 = dataUrl.includes(',') ? dataUrl.split(',').pop() : dataUrl;
      resolve(base64);
    };
    reader.onerror = () => reject(new Error(`Could not read ${file.name}`));
    reader.readAsDataURL(file);
  });
}

$('attachInput').addEventListener('change', async (e) => {
  const files = Array.from(e.target.files || []);
  e.target.value = '';
  if (!files.length) return;
  for (const file of files) {
    if (state.attachments.length >= MAX_ATTACHMENTS) {
      toast(`Max ${MAX_ATTACHMENTS} attachments — "${file.name}" skipped`, false);
      continue;
    }
    if (file.size > MAX_FILE_BYTES) {
      toast(`"${file.name}" is ${formatBytes(file.size)} — max ${formatBytes(MAX_FILE_BYTES)} per file`, false);
      continue;
    }
    if (attachmentTotalBytes() + file.size > MAX_TOTAL_BYTES) {
      toast(`"${file.name}" skipped — total would exceed ${formatBytes(MAX_TOTAL_BYTES)}`, false);
      continue;
    }
    try {
      const content = await readFileAsBase64(file);
      state.attachments.push({
        filename: file.name,
        content,
        contentType: file.type || undefined,
        size: file.size,
      });
    } catch (err) {
      toast(err.message, false);
    }
  }
  renderAttachments();
});

$('clearAttachBtn').addEventListener('click', () => { state.attachments = []; renderAttachments(); });

// ---------- Preview / estimates ----------
function renderTemplate(str, vars) {
  const lower = {};
  for (const [k, v] of Object.entries(vars)) lower[String(k).toLowerCase()] = v ?? '';
  return String(str || '').replace(/{{\s*([\w.-]+)\s*}}/g, (_, k) => lower[String(k).toLowerCase()] ?? '');
}

function updatePreview() {
  const r = state.recipients[0] || { email: 'recipient@example.com', name: 'Ada' };
  $('pvTo').textContent = r.name ? `${r.name} <${r.email}>` : r.email;
  $('pvCc').textContent = $('cc').value.trim() || '—';
  $('pvSubject').textContent = renderTemplate($('subject').value || '(no subject)', r);
  $('pvAttach').textContent = state.attachments.length
    ? state.attachments.map((a) => `${a.filename} (${formatBytes(a.size || 0)})`).join(', ')
    : '—';
  const htmlSrc = $('bodyHtml').value.trim();
  const textSrc = $('bodyText').value.trim();
  // Rendered HTML (like a real inbox, on white) when the HTML tab is active
  // or both parts will be sent; plain text shown for the text tab / fallback.
  const showHtml = (state.activeTab === 'html' || $('sendBoth').checked) && Boolean(htmlSrc);
  $('pvHtml').classList.toggle('hidden', !showHtml);
  if (showHtml) $('pvHtml').srcdoc = renderTemplate(htmlSrc, r);
  const showText = state.activeTab === 'text' || ($('sendBoth').checked && Boolean(textSrc));
  $('pvBody').classList.toggle('hidden', !showText);
  if (showText) {
    $('pvBody').textContent =
      (showHtml ? '--- text fallback ---\n' : '') + renderTemplate(textSrc || '(empty body)', r);
  }
}

// Auto-size the rendered preview to its content (scripts stay blocked by sandbox)
$('pvHtml').addEventListener('load', () => {
  try {
    const doc = $('pvHtml').contentDocument;
    if (doc) {
      $('pvHtml').style.height =
        Math.min(600, Math.max(120, doc.documentElement.scrollHeight + 20)) + 'px';
    }
  } catch { /* keep default height */ }
});

function updateEstimates() {
  const n = state.recipients.length;
  const d = Number($('delay').value || 0);
  $('delayVal').textContent = d;
  $('estCount').textContent = n;
  const total = n > 0 ? (n - 1) * d + n * 0.4 : 0; // ~0.4s API overhead each
  $('estTime').textContent = total < 60 ? `${Math.round(total)}s` : `${Math.floor(total / 60)}m ${Math.round(total % 60)}s`;
  if (n > 100) toast(`Heads up: ${n} recipients exceeds Resend's free 100/day limit — check your plan.`, false);
}

['subject', 'bodyText', 'bodyHtml', 'cc'].forEach((id) => $(id).addEventListener('input', updatePreview));
$('sendBoth').addEventListener('change', updatePreview);
$('delay').addEventListener('input', updateEstimates);

// ---------- Resend API status ----------
async function checkSmtp(silent = false) {
  try {
    const [health, verify] = await Promise.all([
      fetch('/api/health').then((r) => r.json()),
      fetch('/api/verify').then((r) => r.json().then((j) => ({ ...j, status: r.status }))),
    ]);
    $('senderLine').textContent = health.sender ? `sender: ${health.sender}` : 'sender not configured';
    if (verify.success) {
      $('connDot').className = 'dot ok';
      $('connText').textContent = health.sender || 'Resend ready';
      if (!silent) toast(verify.message, true);
    } else {
      $('connDot').className = 'dot bad';
      $('connText').textContent = 'API error';
      if (!silent) toast(verify.message, false);
    }
  } catch {
    $('connDot').className = 'dot bad';
    $('connText').textContent = 'API unreachable';
  }
}
$('verifyBtn').addEventListener('click', () => checkSmtp(false));

// ---------- Send ----------
function toast(msg, ok) {
  const el = $('status');
  el.textContent = msg;
  el.className = 'status ' + (ok ? 'ok' : 'err');
}

function logLine(text, cls = 'info', errMsg = '') {
  const li = document.createElement('li');
  li.className = cls;
  li.innerHTML = `${ICONS[cls] || ICONS.info}<span>${escapeHtml(text)}${errMsg ? `<div class="err-msg">${escapeHtml(errMsg)}</div>` : ''}</span>`;
  $('log').appendChild(li);
  li.scrollIntoView({ block: 'nearest' });
}

$('sendBtn').addEventListener('click', () => sendBulk(false));
$('retryBtn').addEventListener('click', () => sendBulk(true));

async function sendBulk(retryOnly) {
  let recipients = state.recipients;
  if (retryOnly) {
    const failed = new Set(state.lastResults.filter((r) => r.status === 'failed').map((r) => r.email.toLowerCase()));
    recipients = state.recipients.filter((r) => failed.has(r.email.toLowerCase()));
  }
  const subject = $('subject').value.trim();
  const text = $('bodyText').value.trim();
  const html = $('bodyHtml').value.trim();
  const sendBoth = $('sendBoth').checked;
  const cc = $('cc').value.trim();

  if (!recipients.length) return toast('Add at least one recipient first.', false);
  if (!subject) return toast('Subject is required.', false);
  if (!text && !html) return toast('Write a message body first.', false);
  if (attachmentTotalBytes() > MAX_TOTAL_BYTES) {
    return toast(`Attachments exceed ${formatBytes(MAX_TOTAL_BYTES)} total — remove a file first.`, false);
  }

  const btn = $('sendBtn');
  btn.disabled = true;
  btn.innerHTML = `${ICON_LOADER} Sending…`;
  $('log').innerHTML = '';
  $('retryBtn').classList.add('hidden');
  $('exportBtn').classList.add('hidden');
  $('progressWrap').classList.remove('hidden');
  $('progressFill').style.width = '0%';

  // Optimistic client-side progress (server responds once whole batch finishes).
  const total = recipients.length;
  const delayMs = Number($('delay').value) * 1000;
  let tick = 0;
  $('progressText').textContent = `Sending 0 / ${total}… keep this tab open.`;
  const timer = setInterval(() => {
    tick++;
    const guess = Math.min(total - 1, Math.floor(tick * 1.2 / Math.max(delayMs / 1000 + 1.2, 1)));
    $('progressFill').style.width = `${Math.round((guess / total) * 100)}%`;
    $('progressText').textContent = `Sending ~${guess} / ${total}… keep this tab open.`;
  }, 1000);
  recipients.forEach((r) => logLine(`Queued ${r.email}`, 'pending'));

  try {
    const res = await fetch('/api/send-bulk', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        recipients,
        subject,
        text: sendBoth || !html ? text || undefined : undefined,
        html: sendBoth || !text ? html || undefined : (text ? undefined : html || undefined),
        fromName: $('fromName').value.trim() || undefined,
        replyTo: $('replyTo').value.trim() || undefined,
        ...(cc ? { cc } : {}),
        ...(state.attachments.length
          ? { attachments: state.attachments.map(({ filename, content, contentType }) => ({ filename, content, contentType })) }
          : {}),
        delayMs,
      }),
    });
    const data = await res.json();
    clearInterval(timer);
    $('log').innerHTML = '';
    $('progressFill').style.width = '100%';

    if (!res.ok) {
      $('progressText').textContent = 'Send blocked.';
      toast(data.message || 'Send failed', false);
      logLine(data.message || 'Send failed', 'failed');
      return;
    }
    state.lastResults = data.results || [];
    if (state.view === 'analytics') loadAnalytics();
    const { sent = 0, failed = 0, total: t = total } = data.summary || {};
    $('progressText').textContent = `Done: ${sent} sent, ${failed} failed.`;
    toast(data.message, failed === 0);
    (data.results || []).forEach((r) =>
      logLine(`${r.status === 'sent' ? 'Sent →' : 'Failed →'} ${r.email}`, r.status, r.error || '')
    );
    if (failed > 0) $('retryBtn').classList.remove('hidden');
    if ((data.results || []).length) $('exportBtn').classList.remove('hidden');
  } catch (err) {
    clearInterval(timer);
    toast('Network error: ' + err.message, false);
  } finally {
    btn.disabled = false;
    btn.innerHTML = `${ICON_SEND} Send bulk email`;
  }
}

$('exportBtn').addEventListener('click', () => {
  const rows = [['email', 'status', 'error'], ...state.lastResults.map((r) => [r.email, r.status, r.error || ''])];
  const csv = rows.map((r) => r.map((c) => `"${String(c).replace(/"/g, '""')}"`).join(',')).join('\n');
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([csv], { type: 'text/csv' }));
  a.download = '81mailer-results.csv';
  a.click();
});

// ---------- Views (Compose / Analytics) ----------
function switchView(view) {
  state.view = view;
  $('composeView').classList.toggle('hidden', view !== 'compose');
  $('analyticsView').classList.toggle('hidden', view !== 'analytics');
  $('navCompose').classList.toggle('active', view === 'compose');
  $('navAnalytics').classList.toggle('active', view === 'analytics');
  if (view === 'analytics') loadAnalytics();
}
$('navCompose').addEventListener('click', () => switchView('compose'));
$('navAnalytics').addEventListener('click', () => switchView('analytics'));

// ---------- Analytics (audit trail + delivery & engagement KPIs) ----------
async function apiGet(url) {
  const r = await fetch(url);
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(j.message || `Request failed (${r.status})`);
  return j;
}

function kpiCard(label, value, sub) {
  return `<div class="kpi"><div class="kpi-label">${escapeHtml(label)}</div>` +
    `<div class="kpi-value">${escapeHtml(String(value))}</div>` +
    `<div class="kpi-sub muted">${sub || ''}</div></div>`;
}

async function loadAnalytics() {
  const days = Number($('rangeSelect').value || 30);
  try {
    const [status, summary] = await Promise.all([
      apiGet('/api/analytics/status'),
      apiGet(`/api/analytics/summary?days=${days}`),
    ]);
    renderWebhookBanner(status);
    renderKpis(summary.kpis);
    renderChart(summary.series || []);
    analytics.sendsOffset = 0;
    await loadSends(true);
    $('navEventDot').classList.toggle('hidden', !(status.eventsReceived > 0));
  } catch (err) {
    $('webhookBanner').textContent = 'Could not load analytics: ' + err.message;
    $('webhookBanner').className = 'webhook-banner warn small';
  }
}

function renderWebhookBanner(status) {
  const el = $('webhookBanner');
  const url = location.origin + '/api/webhooks/resend';
  $('webhookUrl').textContent = url;
  if (status.eventsReceived > 0) {
    el.innerHTML = `Webhook live — <strong>${status.eventsReceived}</strong> event(s) received` +
      `${status.lastEventAt ? `, latest ${escapeHtml(status.lastEventAt)}` : ''}. Opens/clicks/bounces below are real recipient activity.`;
    el.className = 'webhook-banner ok small';
  } else if (!status.webhookSecretConfigured) {
    el.innerHTML = `No delivery events yet — sends below show accepted/failed status only. ` +
      `To get bounces, opens & clicks: set <code>RESEND_WEBHOOK_SECRET</code> and point a Resend webhook at <code>${escapeHtml(url)}</code> (setup guide below).`;
    el.className = 'webhook-banner warn small';
  } else {
    el.innerHTML = `Webhook secret is configured — waiting for the first event from Resend. ` +
      `Point a Resend webhook at <code>${escapeHtml(url)}</code> (setup guide below).`;
    el.className = 'webhook-banner warn small';
  }
}

function renderKpis(k) {
  const r = k.rates || {};
  $('kpiGrid').innerHTML =
    kpiCard('Sent', k.accepted, `${k.batches} batch(es) · ${k.attempted} attempted`) +
    kpiCard('Delivered', k.delivered, `${r.deliveryRate ?? 0}% delivery rate`) +
    kpiCard('Opened', k.opened, `${r.openRate ?? 0}% open rate`) +
    kpiCard('Clicked', k.clicked, `${r.clickRate ?? 0}% click rate`) +
    kpiCard('Bounced', k.bounced, `${r.bounceRate ?? 0}% bounce rate`) +
    kpiCard('Failed', k.failed, `${k.complained} complaint(s) · ${r.complaintRate ?? 0}% complaint rate`);
}

function renderChart(series) {
  const box = $('chartBars');
  box.innerHTML = '';
  if (!series.length) { box.innerHTML = '<div class="muted small">No activity in range.</div>'; return; }
  const max = Math.max(1, ...series.map((d) => d.sent));
  const step = Math.max(1, Math.ceil(series.length / 14));
  for (const [i, d] of series.entries()) {
    const col = document.createElement('div');
    col.className = 'bar-col';
    col.title = `${d.date}: ${d.sent} sent, ${d.opened} opened, ${d.clicked} clicked, ${d.bounced} bounced`;
    const bar = (val, cls) =>
      `<div class="bar ${cls}" style="height:${Math.max(val > 0 ? 3 : 0, Math.round((val / max) * 100))}%"></div>`;
    col.innerHTML =
      `<div class="bars">${bar(d.sent, 'sent')}${bar(d.opened, 'opened')}${bar(d.clicked, 'clicked')}${bar(d.bounced, 'bounced')}</div>` +
      `<div class="bar-date muted">${i % step === 0 ? escapeHtml(d.date.slice(5)) : ''}</div>`;
    box.appendChild(col);
  }
}

const STATUS_PILL = {
  sent: 'pending', delayed: 'pending', delivered: 'sent', opened: 'sent',
  opened_clicked: 'sent', clicked: 'sent', bounced: 'failed', complained: 'failed',
  failed: 'failed', suppressed: 'pending',
};

async function loadSends(reset) {
  if (analytics.loading) return;
  analytics.loading = true;
  try {
    if (reset) { analytics.sendsOffset = 0; $('sendsBody').innerHTML = ''; $('sendDetail').classList.add('hidden'); }
    const data = await apiGet(`/api/analytics/sends?limit=25&offset=${analytics.sendsOffset}`);
    analytics.sendsTotal = data.total || 0;
    analytics.sendsOffset += (data.items || []).length;
    if (reset && !(data.items || []).length) {
      $('sendsBody').innerHTML = '<tr class="empty"><td colspan="9">No sends recorded yet.</td></tr>';
    }
    for (const s of data.items || []) {
      const e = s.engagement || {};
      const tr = document.createElement('tr');
      tr.innerHTML =
        `<td class="nowrap">${escapeHtml(String(s.createdAt || '').slice(0, 16).replace('T', ' '))}</td>` +
        `<td><strong>${escapeHtml(s.subject || '')}</strong></td>` +
        `<td class="muted">${escapeHtml(s.kind || 'bulk')}</td>` +
        `<td>${e.sent ?? 0}${e.failed ? ` <span class="muted">(+${e.failed} failed)</span>` : ''}</td>` +
        `<td>${e.delivered ?? 0}</td><td>${e.opened ?? 0}</td><td>${e.clicked ?? 0}</td><td>${e.bounced ?? 0}</td>` +
        `<td><button class="btn link sm" data-id="${escapeHtml(s.id)}" type="button">Details</button></td>`;
      $('sendsBody').appendChild(tr);
    }
    $('sendsBody').querySelectorAll('button[data-id]').forEach((b) =>
      b.addEventListener('click', () => showSendDetail(b.dataset.id))
    );
    $('sendsCount').textContent = `${Math.min(analytics.sendsOffset, analytics.sendsTotal)} of ${analytics.sendsTotal} batch(es)`;
    $('moreSends').classList.toggle('hidden', analytics.sendsOffset >= analytics.sendsTotal);
  } catch (err) {
    $('sendsBody').innerHTML = `<tr class="empty"><td colspan="9">Could not load sends: ${escapeHtml(err.message)}</td></tr>`;
  } finally {
    analytics.loading = false;
  }
}

async function showSendDetail(id) {
  const box = $('sendDetail');
  box.classList.remove('hidden');
  box.innerHTML = '<div class="muted small">Loading batch…</div>';
  try {
    const { batch, engagement } = await apiGet(`/api/analytics/sends/${encodeURIComponent(id)}`);
    const msgs = batch.messages || [];
    box.innerHTML =
      `<div class="detail-head"><strong>${escapeHtml(batch.subject || '')}</strong>` +
      `<span class="muted small">${escapeHtml(batch.createdAt || '')} · ${msgs.length} recipient(s)` +
      `${(batch.attachments || []).length ? ` · ${batch.attachments.map((a) => escapeHtml(a.filename)).join(', ')}` : ''}</span></div>` +
      `<div class="table-wrap"><table><thead><tr><th>Recipient</th><th>Status</th><th>Last event</th><th>Opens / clicks</th><th>Error / bounce</th></tr></thead><tbody>` +
      (msgs.map((m) => {
        const pill = STATUS_PILL[m.status] || 'pending';
        const label = String(m.status || 'sent').replace('_', ' + ');
        return `<tr><td><strong>${escapeHtml(m.email)}</strong>${m.name ? `<div class="vars">${escapeHtml(m.name)}</div>` : ''}</td>` +
          `<td><span class="pill ${pill}">${escapeHtml(label)}</span></td>` +
          `<td class="muted small">${escapeHtml(m.lastEvent ? `${m.lastEvent} · ${m.lastEventAt || ''}` : '—')}</td>` +
          `<td class="muted small">${m.openCount || 0} / ${m.clickCount || 0}</td>` +
          `<td class="err-msg">${escapeHtml(m.error || m.bounce?.message || '')}</td></tr>`;
      }).join('') || '<tr class="empty"><td colspan="5">No messages.</td></tr>') +
      `</tbody></table></div>`;
    box.scrollIntoView({ block: 'nearest' });
  } catch (err) {
    box.innerHTML = `<div class="err-msg">Could not load batch: ${escapeHtml(err.message)}</div>`;
  }
}

$('rangeSelect').addEventListener('change', loadAnalytics);
$('refreshAnalytics').addEventListener('click', loadAnalytics);
$('moreSends').addEventListener('click', () => loadSends(false));

// init
renderRecipients();
renderAttachments();
checkSmtp(true);
// Keep analytics fresh while it's on screen (webhook events land any time).
setInterval(() => { if (state.view === 'analytics' && !analytics.loading) loadAnalytics(); }, 30000);
