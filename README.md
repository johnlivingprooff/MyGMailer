# 81Mailer

81Mailer is a bulk emailing tool that sends personalised emails via the Resend API. Compose once with `{{name}}`-style variables, load recipients from CSV, and send each contact an individual email with live progress.

## Features

- Send and receive emails using the Gmail API
- Organize emails with labels and filters
- Automate common email tasks
- Secure authentication with OAuth2

## Installation

Clone the repository:
```bash
git clone https://github.com/johnlivingprooff/MyGMailer.git
cd MyGMailer
npm install
```

## Configuration (`.env`)

```bash
DATABASE_URL=postgresql://user:pass@host:5432/neondb?sslmode=require
RESEND_API_KEY=re_xxxxxxxxx
MAIL_FROM=hello@yourdomain.org
RESEND_WEBHOOK_SECRET=whsec_xxxxxxxxx   # optional, but required for verified delivery/open/click events
```

- `DATABASE_URL` points at Postgres (Neon works out of the box). `PGHOST`/`PGUSER`/`PGPASSWORD`/`PGDATABASE` also work when no URL is set.
- Tables (`batches`, `messages`, `events`) are auto-created on boot. The server **refuses to start** if Postgres is unreachable.
- Resend webhook endpoint: `POST /api/webhooks/resend` — subscribe it to `email.sent/delivered/bounced/complained/opened/clicked/failed` in the Resend dashboard for bounce/open/click analytics.