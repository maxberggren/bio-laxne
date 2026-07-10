# Bio Laxne

A four-seat cinema PWA with server-authoritative bookings, downloadable QR tickets, web push reminders, poster management, and single-use ticket scanning.

## Local development

Requires Node.js 22.5 or newer.

```bash
npm install
npm run dev
```

Open `http://localhost:3000`. The local admin page is at `/admin.html` and uses `malmgrand3` unless `ADMIN_PASSWORD` is set.

## Environment

- `ADMIN_PASSWORD`: Password for the admin and scanner view. Defaults to `malmgrand3` when unset; set this to override it.
- `DATA_DIR`: SQLite and poster upload directory. Defaults to `./data` locally and `/app/data` in the container.
- `VAPID_EMAIL`: Web Push contact URI. Defaults to `mailto:bio@laxne.se`.
- `TICKET_SECRET`: Optional ticket signing secret. A persistent random value is generated if omitted.
- `SESSION_SECRET`: Optional admin session signing secret. A persistent random value is generated if omitted.

The deployment must mount persistent storage at `/app/data` so bookings, push subscriptions, keys, and uploaded posters survive restarts.

## Tests

```bash
npm test
docker build -t bio-laxne .
```
