process.on('unhandledRejection', e => console.error('unhandledRejection:', (e&&e.message)||e));
process.on('uncaughtException', e => console.error('uncaughtException:', (e&&e.message)||e));
const express = require('express');
const { createClient } = require('@supabase/supabase-js');

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

    // daily stats
    if (Array.isArray(b.days) && b.days.length) {
      const rows = b.days.map(d => ({
        device_id: deviceId, day: d.date,
        seconds: Math.round(d.seconds || 0),
        deleted: Math.round(d.deleted || 0),
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

app.get('/', adminAuth, (_req, res) => res.type('html').send(DASH_HTML));

app.listen(PORT, () => console.log(`test-app-backend listening on :${PORT}`));

// ---------- dashboard HTML ----------
const DASH_HTML = `<!doctype html><html><head><meta charset="utf-8"><title>test-app dashboard</title>
<style>
body{font-family:Segoe UI,system-ui,sans-serif;margin:0;background:#f4f6fa;color:#1f2733}
header{background:#13294b;color:#fff;padding:14px 22px;font-weight:700}
main{padding:20px;max-width:1100px;margin:0 auto}
.card{background:#fff;border:1px solid #e6eaf0;border-radius:12px;padding:16px;margin-bottom:16px}
h2{font-size:15px;margin:0 0 12px}
table{width:100%;border-collapse:collapse;font-size:13px}
th,td{text-align:left;padding:8px;border-bottom:1px solid #eef1f6}
th{color:#7b8794;font-weight:600;font-size:11px;text-transform:uppercase}
.dot{display:inline-block;width:9px;height:9px;border-radius:50%;background:#9aa3c4;margin-right:6px}
.on{background:#27c08a}
.muted{color:#7b8794}
button{background:#19b8a6;color:#fff;border:none;border-radius:8px;padding:8px 14px;cursor:pointer}
</style></head><body>
<header>test-app — monitoring dashboard</header>
<main>
  <div class="card"><button onclick="load()">Refresh</button> <span id="msg" class="muted"></span></div>
  <div class="card"><h2>Devices</h2><div id="devices">Loading…</div></div>
  <div class="card"><h2>Time tracked (recent days)</h2><div id="daily"></div></div>
  <div class="card"><h2>Top applications</h2><div id="apps"></div></div>
  <div class="card"><h2>Recent visited sites</h2><div id="visits"></div></div>
  <div class="card"><h2>Screenshots (today)</h2>
    <div style="margin-bottom:10px"><select id="shotDevice"></select> <button onclick="loadShots()">Load screenshots</button> <span id="shotMsg" class="muted"></span></div>
    <div id="shots" style="display:grid;grid-template-columns:repeat(auto-fill,minmax(220px,1fr));gap:10px"></div>
  </div>
</main>
<script>
function fmt(s){s=Math.round(s||0);const h=Math.floor(s/3600),m=Math.floor((s%3600)/60);return h?h+'h '+m+'m':(m?m+'m':s+'s');}
function tbl(rows,cols){if(!rows.length)return '<div class="muted">No data.</div>';
  let h='<table><tr>'+cols.map(c=>'<th>'+c[0]+'</th>').join('')+'</tr>';
  for(const r of rows){h+='<tr>'+cols.map(c=>'<td>'+(c[1](r)??'')+'</td>').join('')+'</tr>';}
  return h+'</table>';}
async function load(){
  document.getElementById('msg').textContent='Loading…';
  const r=await fetch('/api/data'); const d=await r.json();
  if(d.error){document.getElementById('msg').textContent='Error: '+JSON.stringify(d.error);}
  else document.getElementById('msg').textContent='Updated '+new Date().toLocaleString();
  document.getElementById('devices').innerHTML=tbl(d.devices||[],[
    ['Status',x=>'<span class="dot '+(x.running?'on':'')+'"></span>'+(x.running?'Running':'Stopped')],
    ['Device',x=>x.label||x.id],['Today',x=>fmt(x.today_seconds)],
    ['Last seen',x=>x.last_seen?new Date(x.last_seen).toLocaleString():'']]);
  document.getElementById('daily').innerHTML=tbl((d.daily||[]).slice(0,60),[
    ['Device',x=>x.device_id],['Day',x=>x.day],['Tracked',x=>fmt(x.seconds)],
    ['Activity',x=>x.active_pct+'%'],['Deleted',x=>x.deleted]]);
  document.getElementById('apps').innerHTML=tbl((d.apps||[]).slice(0,40),[
    ['Device',x=>x.device_id],['App',x=>x.app],['Time',x=>fmt(x.seconds)]]);
  const sd=document.getElementById('shotDevice'); const cur=sd.value;
  sd.innerHTML=(d.devices||[]).map(x=>'<option value="'+x.id+'">'+(x.label||x.id)+'</option>').join('');
  if(cur)sd.value=cur;
  document.getElementById('visits').innerHTML=tbl((d.visits||[]).slice(0,200),[
    ['When',x=>new Date(x.ts).toLocaleString()],['Device',x=>x.device_id],
    ['Site',x=>x.domain],['Title',x=>(x.title||'').slice(0,60)],['Browser',x=>x.browser]]);
}
async function loadShots(){
  const dev=document.getElementById('shotDevice').value; const box=document.getElementById('shots'); const m=document.getElementById('shotMsg');
  if(!dev){m.textContent='No device selected';return;} m.textContent='Loading…'; box.innerHTML='';
  const r=await fetch('/api/shots?device='+encodeURIComponent(dev)); const d=await r.json();
  if(d.error){m.textContent='Error: '+d.error;return;}
  m.textContent=(d.files&&d.files.length)?('Day '+(d.day||'')+' — '+d.files.length+' shots'):'No screenshots yet';
  box.innerHTML=(d.files||[]).map(f=>'<a href="'+f.url+'" target="_blank"><img src="'+f.url+'" style="width:100%;border:1px solid #e6eaf0;border-radius:8px" title="'+f.name+'"></a>').join('');
}
load();
</script></body></html>`;
