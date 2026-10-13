// db.js - Postgres audit store for 81Mailer (send batches, messages, webhook events).
//
// Connection: DATABASE_URL (e.g. Neon), else pg's PG* env vars / local socket.
// Tables are auto-created on boot (CREATE TABLE IF NOT EXISTS).
const { Pool } = require('pg');

const pool = new Pool(
  process.env.DATABASE_URL
    ? {
        connectionString: process.env.DATABASE_URL,
        // Managed providers (Neon, Supabase, ...) terminate TLS at a pooler
        // with certs node can't verify against its CA bundle.
        ...(process.env.DATABASE_URL.includes('sslmode=require')
          ? { ssl: { rejectUnauthorized: false } }
          : {}),
      }
    : {}
);

pool.on('error', (err) => console.error('Postgres pool error:', err.message));

const SCHEMA = `
CREATE TABLE IF NOT EXISTS batches (
  id          TEXT PRIMARY KEY,
  kind        TEXT NOT NULL DEFAULT 'bulk',
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  subject     TEXT NOT NULL DEFAULT '',
  sender      TEXT NOT NULL DEFAULT '',
  from_name   TEXT,
  reply_to    TEXT,
  cc          TEXT[] NOT NULL DEFAULT '{}',
  total       INT NOT NULL DEFAULT 0,
  sent        INT NOT NULL DEFAULT 0,
  failed      INT NOT NULL DEFAULT 0,
  attachments JSONB NOT NULL DEFAULT '[]'
);
CREATE TABLE IF NOT EXISTS messages (
  id            BIGSERIAL PRIMARY KEY,
  batch_id      TEXT NOT NULL REFERENCES batches(id) ON DELETE CASCADE,
  email         TEXT NOT NULL,
  name          TEXT,
  status        TEXT NOT NULL DEFAULT 'sent',
  initial       TEXT NOT NULL DEFAULT 'sent',
  resend_id     TEXT,
  error         TEXT,
  bounce        JSONB,
  open_count    INT NOT NULL DEFAULT 0,
  click_count   INT NOT NULL DEFAULT 0,
  opened_at     TIMESTAMPTZ,
  clicked_at    TIMESTAMPTZ,
  last_event    TEXT,
  last_event_at TIMESTAMPTZ,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_messages_batch ON messages(batch_id);
CREATE INDEX IF NOT EXISTS idx_messages_resend ON messages(resend_id);
CREATE TABLE IF NOT EXISTS events (
  svix_id    TEXT PRIMARY KEY,
  type       TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  email_id   TEXT,
  recipient  TEXT,
  subject    TEXT,
  payload    JSONB NOT NULL DEFAULT '{}'
);
CREATE INDEX IF NOT EXISTS idx_events_created ON events(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_events_email ON events(email_id);
`;

const iso = (v) => (v instanceof Date ? v.toISOString() : v ?? null);

async function initDb() {
  // Fail fast: the audit trail is load-bearing, a silent fallback would diverge.
  await pool.query('SELECT 1');
  await pool.query(SCHEMA);
}

async function recordBatch(b) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(
      `INSERT INTO batches (id, kind, created_at, subject, sender, from_name, reply_to, cc, total, sent, failed, attachments)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
       ON CONFLICT (id) DO NOTHING`,
      [b.id, b.kind, b.createdAt, b.subject, b.from, b.fromName, b.replyTo, b.cc,
       b.counts.total, b.counts.sent, b.counts.failed, JSON.stringify(b.attachments)]
    );
    for (const m of b.messages) {
      await client.query(
        `INSERT INTO messages (batch_id, email, name, status, initial, resend_id, error)
         VALUES ($1,$2,$3,$4,$5,$6,$7)`,
        [b.id, m.email, m.name, m.status, m.initial, m.resendId, m.error]
      );
    }
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

async function applyWebhookEvent({ svixId, type, createdAt, data }) {
  const emailId = data?.email_id || null;
  const to = Array.isArray(data?.to) ? data.to[0] || null : data?.to || null;
  const ins = await pool.query(
    `INSERT INTO events (svix_id, type, created_at, email_id, recipient, subject, payload)
     VALUES ($1,$2,$3,$4,$5,$6,$7)
     ON CONFLICT (svix_id) DO NOTHING`,
    [svixId, type, createdAt, emailId, to, data?.subject || null, JSON.stringify(data || {})]
  );
  if (ins.rowCount === 0) return { deduped: true };
  if (!emailId) return { deduped: false, matched: false };

  const found = await pool.query('SELECT status FROM messages WHERE resend_id = $1', [emailId]);
  if (found.rowCount === 0) return { deduped: false, matched: false };
  const cur = found.rows[0].status;

  let status = cur;
  if (type === 'email.delivered' && !['opened', 'opened_clicked', 'clicked'].includes(cur)) status = 'delivered';
  else if (type === 'email.opened') status = 'opened';
  else if (type === 'email.clicked') status = cur === 'opened' || cur === 'opened_clicked' ? 'opened_clicked' : 'clicked';
  else if (type === 'email.bounced') status = 'bounced';
  else if (type === 'email.complained') status = 'complained';
  else if (type === 'email.failed') status = 'failed';
  else if (type === 'email.suppressed') status = 'suppressed';
  else if (type === 'email.delivery_delayed' && cur === 'sent') status = 'delayed';

  const sets = ['status = $2', 'last_event = $3', 'last_event_at = $4'];
  const params = [emailId, status, type, createdAt];
  if (type === 'email.opened') {
    sets.push('open_count = open_count + 1', `opened_at = COALESCE(opened_at, $${params.length + 1}::timestamptz)`);
    params.push(createdAt);
  }
  if (type === 'email.clicked') {
    sets.push('click_count = click_count + 1', `clicked_at = COALESCE(clicked_at, $${params.length + 1}::timestamptz)`);
    params.push(createdAt);
  }
  if (type === 'email.bounced') {
    sets.push(`bounce = $${params.length + 1}::jsonb`);
    params.push(JSON.stringify(data?.bounce || null));
  }
  if (type === 'email.failed' && data?.error) {
    sets.push(`error = $${params.length + 1}`);
    params.push(typeof data.error === 'string' ? data.error : JSON.stringify(data.error));
  }
  await pool.query(`UPDATE messages SET ${sets.join(', ')} WHERE resend_id = $1`, params);
  return { deduped: false, matched: true };
}

async function getStatus() {
  const { rows: [r] } = await pool.query(`
    SELECT (SELECT count(*)::int FROM batches) AS batches,
           (SELECT count(*)::int FROM messages) AS messages,
           (SELECT count(*)::int FROM events) AS events,
           (SELECT max(created_at) FROM events) AS last_event_at`);
  return {
    batches: r.batches,
    messages: r.messages,
    eventsReceived: r.events,
    lastEventAt: iso(r.last_event_at),
  };
}

const pct = (n, d) => (d > 0 ? Math.round((n / d) * 1000) / 10 : 0);

async function getSummary(days) {
  const k = (await pool.query(
    `SELECT count(*)::int AS attempted,
            count(*) FILTER (WHERE m.initial = 'sent')::int AS accepted,
            count(*) FILTER (WHERE m.status IN ('delivered','opened','opened_clicked','clicked'))::int AS delivered,
            count(*) FILTER (WHERE m.status IN ('opened','opened_clicked','clicked'))::int AS opened,
            count(*) FILTER (WHERE m.status IN ('opened_clicked','clicked'))::int AS clicked,
            count(*) FILTER (WHERE m.status = 'bounced')::int AS bounced,
            count(*) FILTER (WHERE m.status = 'complained')::int AS complained,
            count(*) FILTER (WHERE m.status = 'failed' OR m.initial = 'failed')::int AS failed,
            count(DISTINCT b.id)::int AS batches
     FROM messages m JOIN batches b ON b.id = m.batch_id
     WHERE b.created_at >= now() - ($1 * interval '1 day')`,
    [days]
  )).rows[0];

  const series = (await pool.query(
    // to_char keeps the day as plain YYYY-MM-DD text: node-postgres parses
    // DATE columns as local-midnight Dates, which toISOString() can shift
    // a day back on non-UTC servers.
    `SELECT to_char(d.day, 'YYYY-MM-DD') AS date,
            COALESCE(s.sent, 0)::int AS sent,
            COALESCE(e.delivered, 0)::int AS delivered,
            COALESCE(e.opened, 0)::int AS opened,
            COALESCE(e.clicked, 0)::int AS clicked,
            COALESCE(e.bounced, 0)::int AS bounced
     FROM (SELECT generate_series(now()::date - ($1 * interval '1 day') + interval '1 day', now()::date, '1 day') AS day) d
     LEFT JOIN (
       SELECT (b.created_at AT TIME ZONE 'UTC')::date AS day, count(*) AS sent
       FROM messages m JOIN batches b ON b.id = m.batch_id
       WHERE m.initial = 'sent' AND b.created_at >= now() - ($1 * interval '1 day')
       GROUP BY 1
     ) s ON s.day = d.day
     LEFT JOIN (
       SELECT (created_at AT TIME ZONE 'UTC')::date AS day,
              count(*) FILTER (WHERE type = 'email.delivered') AS delivered,
              count(*) FILTER (WHERE type = 'email.opened') AS opened,
              count(*) FILTER (WHERE type = 'email.clicked') AS clicked,
              count(*) FILTER (WHERE type = 'email.bounced') AS bounced
       FROM events
       WHERE created_at >= now() - ($1 * interval '1 day')
       GROUP BY 1
     ) e ON e.day = d.day
     ORDER BY d.day`,
    [Math.min(days, 90)]
  )).rows;

  const recentEvents = (await pool.query(
    `SELECT svix_id AS "svixId", type, created_at AS "createdAt",
            email_id AS "emailId", recipient AS "to", subject
     FROM events ORDER BY created_at DESC LIMIT 20`
  )).rows.map((r) => ({ ...r, createdAt: iso(r.createdAt) }));

  return {
    kpis: {
      batches: k.batches,
      attempted: k.attempted,
      accepted: k.accepted,
      delivered: k.delivered,
      opened: k.opened,
      clicked: k.clicked,
      bounced: k.bounced,
      complained: k.complained,
      failed: k.failed,
      rates: {
        deliveryRate: pct(k.delivered, k.accepted),
        openRate: pct(k.opened, k.delivered || k.accepted),
        clickRate: pct(k.clicked, k.delivered || k.accepted),
        bounceRate: pct(k.bounced, k.accepted),
        complaintRate: pct(k.complained, k.accepted),
      },
    },
    series,
    recentEvents,
  };
}

async function listSends(limit, offset) {
  const { rows } = await pool.query(
    `SELECT b.id, b.kind, b.created_at AS "createdAt", b.subject, b.sender AS "from",
            count(m.id)::int AS total,
            count(*) FILTER (WHERE m.initial = 'sent')::int AS sent,
            count(*) FILTER (WHERE m.initial = 'failed')::int AS failed,
            count(*) FILTER (WHERE m.status IN ('delivered','opened','opened_clicked','clicked'))::int AS delivered,
            count(*) FILTER (WHERE m.status IN ('opened','opened_clicked','clicked'))::int AS opened,
            count(*) FILTER (WHERE m.status IN ('opened_clicked','clicked'))::int AS clicked,
            count(*) FILTER (WHERE m.status = 'bounced')::int AS bounced,
            count(*) FILTER (WHERE m.status = 'complained')::int AS complained,
            coalesce(jsonb_array_length(b.attachments), 0)::int AS "attachmentCount",
            count(*) OVER ()::int AS full_count
     FROM batches b LEFT JOIN messages m ON m.batch_id = b.id
     GROUP BY b.id
     ORDER BY b.created_at DESC, b.id DESC
     LIMIT $1 OFFSET $2`,
    [limit, offset]
  );
  return {
    total: rows.length ? rows[0].full_count : 0,
    items: rows.map(({ full_count: _drop, ...r }) => ({
      id: r.id,
      kind: r.kind,
      createdAt: iso(r.createdAt),
      subject: r.subject,
      from: r.from,
      engagement: {
        total: r.total, sent: r.sent, failed: r.failed, delivered: r.delivered,
        opened: r.opened, clicked: r.clicked, bounced: r.bounced, complained: r.complained,
      },
      attachmentCount: r.attachmentCount,
    })),
  };
}

async function getBatch(id) {
  const b = (await pool.query(
    `SELECT id, kind, created_at AS "createdAt", subject, sender AS "from",
            from_name AS "fromName", reply_to AS "replyTo", cc,
            total, sent, failed, attachments
     FROM batches WHERE id = $1`,
    [id]
  )).rows[0];
  if (!b) return null;
  const messages = (await pool.query(
    `SELECT email, name, status, initial, resend_id AS "resendId", error, bounce,
            open_count AS "openCount", click_count AS "clickCount",
            opened_at AS "openedAt", clicked_at AS "clickedAt",
            last_event AS "lastEvent", last_event_at AS "lastEventAt"
     FROM messages WHERE batch_id = $1 ORDER BY id`,
    [id]
  )).rows.map((m) => ({
    ...m,
    openedAt: iso(m.openedAt),
    clickedAt: iso(m.clickedAt),
    lastEventAt: iso(m.lastEventAt),
  }));
  const engagement = {
    total: messages.length,
    sent: messages.filter((m) => m.initial === 'sent').length,
    failed: messages.filter((m) => m.initial === 'failed').length,
    delivered: messages.filter((m) => ['delivered', 'opened', 'opened_clicked', 'clicked'].includes(m.status)).length,
    opened: messages.filter((m) => ['opened', 'opened_clicked', 'clicked'].includes(m.status)).length,
    clicked: messages.filter((m) => ['opened_clicked', 'clicked'].includes(m.status)).length,
    bounced: messages.filter((m) => m.status === 'bounced').length,
    complained: messages.filter((m) => m.status === 'complained').length,
  };
  return {
    batch: {
      id: b.id,
      kind: b.kind,
      createdAt: iso(b.createdAt),
      subject: b.subject,
      from: b.from,
      fromName: b.fromName,
      replyTo: b.replyTo,
      cc: b.cc || [],
      counts: { total: b.total, sent: b.sent, failed: b.failed },
      attachments: b.attachments || [],
      messages,
    },
    engagement,
  };
}

module.exports = { initDb, recordBatch, applyWebhookEvent, getStatus, getSummary, listSends, getBatch };
