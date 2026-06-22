# test-app-backend

Express API that receives stats from the **test-app** desktop client and stores
them in **Supabase**, plus a password-protected admin dashboard.

```
desktop app  --HTTPS + token-->  this server (holds Supabase secret key)  -->  Supabase
                                        |
                                   admin dashboard (/)
```

## 1. Set up the database (once)
Supabase → **SQL Editor** → New query → paste the contents of **schema.sql** → **Run**.

## 2. Rotate your secret key
You shared your `sb_secret_...` key, so regenerate it in Supabase
(Settings → API Keys → secret key → ⋯ → roll). Use the NEW value below.

## 3. Configure environment
Copy `.env.example` and set:
- `SUPABASE_URL`        = https://bissdhhsygxcqxresbkd.supabase.co
- `SUPABASE_SECRET_KEY` = your NEW sb_secret_... key
- `INGEST_TOKEN`        = a long random string (the desktop app will use this)
- `ADMIN_USER` / `ADMIN_PASS` = dashboard login
(`PORT` is set automatically by the host.)

## 4. Deploy free on Render
1. Put this folder in a GitHub repo.
2. Render.com → New → **Blueprint** → pick the repo (it reads `render.yaml`),
   or New → **Web Service** → Build `npm install`, Start `npm start`.
3. Add the env vars from step 3 (Render can auto-generate `INGEST_TOKEN` — copy it).
4. Deploy. Your base URL will be like `https://test-app-backend.onrender.com`.

> Render's free web service sleeps after inactivity and wakes on the next
> request (first call may take ~30s). Railway and Fly.io work the same way with
> `npm start`.

## 5. Point the desktop app at it
In test-app (admin → Settings → Cloud sync): set **Server URL** to your deployed
URL and **Ingest token** to the same `INGEST_TOKEN`, tick **Enable cloud sync**.

## Endpoints
- `GET  /health` — liveness check.
- `POST /api/sync` — desktop client pushes data (Bearer = INGEST_TOKEN).
- `GET  /` and `GET /api/data` — admin dashboard (Basic auth = ADMIN_USER/PASS).

## Local run
```
npm install
SUPABASE_URL=... SUPABASE_SECRET_KEY=... INGEST_TOKEN=dev ADMIN_USER=admin ADMIN_PASS=admin npm start
# open http://localhost:3000
```
