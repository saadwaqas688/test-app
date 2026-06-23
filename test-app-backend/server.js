process.on('unhandledRejection', e => console.error('unhandledRejection:', (e&&e.message)||e));
process.on('uncaughtException', e => console.error('uncaughtException:', (e&&e.message)||e));
const express = require('express');
const { createClient } = require('@supabase/supabase-js');
const fs = require('fs');
const path = require('path');

const {
  SUPABASE_URL,
  SUPABASE_SECRET_KEY,
  INGEST_TOKEN = '',
  ADMIN_USER = 'admin',
  ADMIN_PASS = 'change-me',
  PORT = 3000
} = process.env;

if (!SUPABASE_URL || !SUPABASE_SECRET_KEY) {
  console.warn('[warn] SUPABASE_URL / SUPABASE_SECRET_KEY not set — DB calls will fail until configured.');
}

// service (secret) key bypasses RLS — server-side only
const supa = createClient(SUPABASE_URL || 'http://localhost', SUPABASE_SECRET_KEY || 'x', {
  auth: { persistSession: false }
});

const BUCKET = 'screenshots';
async function ensureBucket(){
  try{ const { data } = await supa.storage.getBucket(BUCKET); if(data) return; }catch(e){}
  try{ await supa.storage.createBucket(BUCKET, { public:false }); console.log('created storage bucket', BUCKET); }catch(e){ console.warn('bucket', e.message||e); }
}
ensureBucket();

function dayStr(d){ d=d||new Date(); const p=n=>String(n).padStart(2,'0'); return `${d.getFullYear()}-${p(d.getMonth()+1)}-${p(d.getDate())}`; }
async function purgeDeviceDays(deviceId, keepDay){
  try{
    const { data:days } = await supa.storage.from(BUCKET).list(deviceId, { limit:1000 });
    if(!days) return;
    for(const d of days){ if(!d.name || d.name===keepDay) continue;
      const { data:files } = await supa.storage.from(BUCKET).list(`${deviceId}/${d.name}`, { limit:1000 });
      if(files && files.length) await supa.storage.from(BUCKET).remove(files.map(x=>`${deviceId}/${d.name}/${x.name}`));
    }
  }catch(e){}
}

const app = express();
app.use(express.json({ limit: '4mb' }));

// ---------- health ----------
app.get('/health', (_req, res) => res.json({ ok: true, time: new Date().toISOString() }));

// ---------- ingest from desktop app ----------
function checkIngest(req, res) {
  const auth = req.get('authorization') || '';
  const token = auth.replace(/^Bearer\s+/i, '');
  if (!INGEST_TOKEN || token !== INGEST_TOKEN) { res.status(401).json({ error: 'unauthorized' }); return false; }
  return true;
}

app.post('/api/sync', async (req, res) => {
  if (!checkIngest(req, res)) return;
  try {
    const b = req.body || {};
    const deviceId = String(b.deviceId || '').slice(0, 200);
    if (!deviceId) return res.status(400).json({ error: 'deviceId required' });
    const now = new Date().toISOString();

    // device
    await supa.from('devices').upsert({
      id: deviceId,
      label: String(b.label || '').slice(0, 200),
      last_seen: now,
      running: !!(b.status && b.status.running),
      today_seconds: Math.round((b.status && b.status.todaySeconds) || 0)
    }, { onConflict: 'id' });

    // daily stats — never let trimmed/restarted clients lower a day's total (use max)
    if (Array.isArray(b.days) && b.days.length) {
      const dayKeys = b.days.map(d => d.date);
      const { data: existing } = await supa.from('daily_stats')
        .select('day,seconds,deleted').eq('device_id', deviceId).in('day', dayKeys);
      const ex = {}; (existing || []).forEach(r => ex[r.day] = r);
      const rows = b.days.map(d => ({
        device_id: deviceId, day: d.date,
        seconds: Math.max(Math.round(d.seconds || 0), (ex[d.date] && ex[d.date].seconds) || 0),
        deleted: Math.max(Math.round(d.deleted || 0), (ex[d.date] && ex[d.date].deleted) || 0),
        active_pct: Math.round(d.activePct || 0)
      }));
      await supa.from('daily_stats').upsert(rows, { onConflict: 'device_id,day' });
    }

    // app usage (latest snapshot)
    if (Array.isArray(b.apps) && b.apps.length) {
      const rows = b.apps.map(a => ({
        device_id: deviceId, app: String(a.app || 'Unknown').slice(0, 200),
        seconds: Math.round(a.seconds || 0), updated_at: now
      }));
      await supa.from('app_usage').upsert(rows, { onConflict: 'device_id,app' });
    }

    // site visits (dedup, ignore duplicates)
    let inserted = 0;
    if (Array.isArray(b.visits) && b.visits.length) {
      const rows = b.visits.slice(0, 2000).map(v => ({
        device_id: deviceId, ts: v.t, domain: v.domain,
        title: String(v.title || '').slice(0, 200), url: String(v.url || '').slice(0, 400),
        browser: v.browser
      }));
      const { error } = await supa.from('site_visits').upsert(rows, { onConflict: 'device_id,ts,url', ignoreDuplicates: true });
      if (!error) inserted = rows.length;
    }

    res.json({ ok: true, device: deviceId, visits: inserted });
  } catch (e) {
    console.error('sync error', e);
    res.status(500).json({ error: 'sync_failed', detail: String(e.message || e) });
  }
});

// ---------- screenshot upload (current-day only on server) ----------
app.post('/api/screenshot', async (req, res) => {
  if (!checkIngest(req, res)) return;
  try {
    const { deviceId, day, name, dataB64 } = req.body || {};
    if (!deviceId || !day || !name || !dataB64) return res.status(400).json({ error: 'missing fields' });
    const buf = Buffer.from(dataB64, 'base64');
    const key = `${deviceId}/${day}/${name}`;
    const up = await supa.storage.from(BUCKET).upload(key, buf, { contentType: 'image/jpeg', upsert: true });
    if (up.error) return res.status(500).json({ error: up.error.message });
    purgeDeviceDays(deviceId, day); // fire-and-forget delete of previous days
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: String(e.message || e) }); }
});

// ---------- admin dashboard ----------
function adminAuth(req, res, next) {
  const hdr = req.get('authorization') || '';
  const b64 = hdr.replace(/^Basic\s+/i, '');
  const [u, p] = Buffer.from(b64, 'base64').toString().split(':');
  if (u === ADMIN_USER && p === ADMIN_PASS) return next();
  res.set('WWW-Authenticate', 'Basic realm="test-app admin"').status(401).send('Auth required');
}

app.get('/api/data', adminAuth, async (_req, res) => {
  try {
    const [devices, daily, apps, visits] = await Promise.all([
      supa.from('devices').select('*').order('last_seen', { ascending: false }),
      supa.from('daily_stats').select('*').order('day', { ascending: false }).limit(2000),
      supa.from('app_usage').select('*').order('seconds', { ascending: false }).limit(2000),
      supa.from('site_visits').select('device_id,ts,domain,title,browser').order('ts', { ascending: false }).limit(500)
    ]);
    res.json({
      devices: devices.data || [], daily: daily.data || [],
      apps: apps.data || [], visits: visits.data || [],
      error: devices.error || daily.error || apps.error || visits.error || null
    });
  } catch (e) { res.status(500).json({ error: String(e.message || e) }); }
});

app.get('/api/shots', adminAuth, async (req, res) => {
  try {
    const device = String(req.query.device || ''); if (!device) return res.json({ files: [] });
    const { data: days } = await supa.storage.from(BUCKET).list(device, { limit: 1000 });
    const dayNames = (days || []).map(d => d.name).filter(n => /^\d{4}-\d{2}-\d{2}$/.test(n)).sort().reverse();
    if (!dayNames.length) return res.json({ files: [] });
    const day = dayNames[0];
    const { data: files } = await supa.storage.from(BUCKET).list(`${device}/${day}`, { limit: 1000, sortBy: { column: 'name', order: 'desc' } });
    const out = [];
    for (const f of (files || []).slice(0, 200)) {
      const { data: s } = await supa.storage.from(BUCKET).createSignedUrl(`${device}/${day}/${f.name}`, 3600);
      if (s && s.signedUrl) out.push({ name: f.name, url: s.signedUrl });
    }
    res.json({ day, files: out });
  } catch (e) { res.json({ files: [], error: String(e.message || e) }); }
});

app.get('/api/storage', adminAuth, async (_req, res) => {
  try {
    let bytes = 0, files = 0;
    const { data: devs } = await supa.storage.from(BUCKET).list('', { limit: 1000 });
    for (const dv of (devs || [])) {
      if (!dv.name) continue;
      const { data: days } = await supa.storage.from(BUCKET).list(dv.name, { limit: 1000 });
      for (const dy of (days || [])) {
        if (!dy.name) continue;
        const { data: fl } = await supa.storage.from(BUCKET).list(`${dv.name}/${dy.name}`, { limit: 1000 });
        for (const f of (fl || [])) { files++; bytes += (f.metadata && f.metadata.size) || 0; }
      }
    }
    const quota = (parseInt(process.env.STORAGE_QUOTA_MB, 10) || 1024) * 1024 * 1024;
    res.json({ bytes, files, quota, remaining: Math.max(0, quota - bytes) });
  } catch (e) { res.json({ bytes: 0, files: 0, quota: 0, remaining: 0, error: String(e.message || e) }); }
});

app.post('/api/delete-shots', adminAuth, async (req, res) => {
  try {
    const device = String((req.query && req.query.device) || (req.body && req.body.device) || '');
    if (!device) return res.status(400).json({ error: 'device required' });
    let removed = 0;
    const { data: days } = await supa.storage.from(BUCKET).list(device, { limit: 1000 });
    for (const dy of (days || [])) {
      if (!dy.name) continue;
      const { data: fl } = await supa.storage.from(BUCKET).list(`${device}/${dy.name}`, { limit: 1000 });
      if (fl && fl.length) { await supa.storage.from(BUCKET).remove(fl.map(f => `${device}/${dy.name}/${f.name}`)); removed += fl.length; }
    }
    res.json({ ok: true, removed });
  } catch (e) { res.status(500).json({ error: String(e.message || e) }); }
});

app.get('/', adminAuth, (_req, res) => res.type('html').send(fs.readFileSync(path.join(__dirname,'dashboard.html'),'utf8')));

app.listen(PORT, () => console.log(`test-app-backend listening on :${PORT}`));
