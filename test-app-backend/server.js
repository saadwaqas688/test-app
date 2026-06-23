process.on('unhandledRejection', e => console.error('unhandledRejection:', (e&&e.message)||e));
process.on('uncaughtException', e => console.error('uncaughtException:', (e&&e.message)||e));

const express = require('express');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { createClient } = require('@supabase/supabase-js');

const {
  SUPABASE_URL, SUPABASE_SECRET_KEY,
  ADMIN_USER = 'admin', ADMIN_PASS = 'change-me',
  JWT_SECRET, PORT = 3000
} = process.env;

const SECRET = JWT_SECRET || SUPABASE_SECRET_KEY || 'dev-secret';
const supa = createClient(SUPABASE_URL || 'http://localhost', SUPABASE_SECRET_KEY || 'x', { auth: { persistSession: false } });
const BUCKET = 'screenshots';
const app = express();
app.use(express.json({ limit: '6mb' }));

// ---------- crypto helpers ----------
function hashPw(pw, salt){ return crypto.pbkdf2Sync(String(pw), salt, 120000, 32, 'sha256').toString('hex'); }
function b64url(b){ return Buffer.from(b).toString('base64').replace(/\+/g,'-').replace(/\//g,'_').replace(/=+$/,''); }
function sign(payload){ const body=b64url(JSON.stringify(payload)); const sig=crypto.createHmac('sha256',SECRET).update(body).digest('base64').replace(/\+/g,'-').replace(/\//g,'_').replace(/=+$/,''); return body+'.'+sig; }
function verify(token){ if(!token||token.indexOf('.')<0) return null; const [body,sig]=token.split('.');
  const exp=crypto.createHmac('sha256',SECRET).update(body).digest('base64').replace(/\+/g,'-').replace(/\//g,'_').replace(/=+$/,'');
  if(exp!==sig) return null; try{ return JSON.parse(Buffer.from(body.replace(/-/g,'+').replace(/_/g,'/'),'base64').toString()); }catch(e){ return null; } }

// ---------- startup: bucket + bootstrap admin ----------
async function ensureBucket(){ try{ const {data}=await supa.storage.getBucket(BUCKET); if(data) return; }catch(e){} try{ await supa.storage.createBucket(BUCKET,{public:false}); }catch(e){} }
async function ensureAdmin(){
  try{
    const { data } = await supa.from('users').select('id').eq('username', ADMIN_USER).maybeSingle();
    if(!data){ const salt=crypto.randomBytes(16).toString('hex');
      await supa.from('users').insert({ username:ADMIN_USER, pass_hash:hashPw(ADMIN_PASS,salt), pass_salt:salt, role:'admin' });
      console.log('bootstrapped admin user:', ADMIN_USER);
    }
  }catch(e){ console.warn('ensureAdmin', e.message||e); }
}
ensureBucket(); ensureAdmin();

// ---------- auth middleware ----------
function auth(req,res,next){ const t=(req.get('authorization')||'').replace(/^Bearer\s+/i,''); const u=verify(t);
  if(!u) return res.status(401).json({error:'unauthorized'}); req.user=u; next(); }
function adminOnly(req,res,next){ if(req.user.role!=='admin') return res.status(403).json({error:'forbidden'}); next(); }
async function scopeUserId(req){
  if(req.user.role==='admin' && req.query.user){
    const { data } = await supa.from('users').select('id').eq('username', req.query.user).maybeSingle();
    return data ? data.id : '__none__';
  }
  return req.user.uid;
}

// ---------- time ----------
function dayStr(d){ d=d||new Date(); const p=n=>String(n).padStart(2,'0'); return `${d.getFullYear()}-${p(d.getMonth()+1)}-${p(d.getDate())}`; }

// ---------- health ----------
app.get('/health', (_q,res)=>res.json({ok:true,time:new Date().toISOString()}));

// ---------- auth endpoints ----------
app.post('/api/login', async (req,res)=>{
  try{
    const { username, password } = req.body||{};
    if(!username||!password) return res.status(400).json({error:'username and password required'});
    const { data:u } = await supa.from('users').select('*').eq('username', username).maybeSingle();
    if(!u || hashPw(password,u.pass_salt)!==u.pass_hash) return res.status(401).json({error:'Invalid username or password'});
    const token = sign({ uid:u.id, username:u.username, role:u.role, iat:Date.now() });
    res.json({ token, username:u.username, role:u.role });
  }catch(e){ res.status(500).json({error:String(e.message||e)}); }
});
app.get('/api/me', auth, (req,res)=>res.json({ username:req.user.username, role:req.user.role }));
app.post('/api/me/password', auth, async (req,res)=>{
  try{ const { password }=req.body||{}; if(!password||String(password).length<4) return res.status(400).json({error:'Password must be at least 4 characters.'});
    const salt=crypto.randomBytes(16).toString('hex');
    await supa.from('users').update({ pass_hash:hashPw(password,salt), pass_salt:salt }).eq('id', req.user.uid);
    res.json({ok:true});
  }catch(e){ res.status(500).json({error:String(e.message||e)}); }
});

// ---------- admin: user management ----------
app.get('/api/users', auth, adminOnly, async (_q,res)=>{
  const { data } = await supa.from('users').select('id,username,role,created_at').order('created_at',{ascending:true});
  res.json({ users:data||[] });
});
app.post('/api/users', auth, adminOnly, async (req,res)=>{
  try{ const { username, password, role } = req.body||{};
    if(!username||!password) return res.status(400).json({error:'username and password required'});
    if(String(password).length<4) return res.status(400).json({error:'Password must be at least 4 characters.'});
    const { data:ex } = await supa.from('users').select('id').eq('username',username).maybeSingle();
    if(ex) return res.status(409).json({error:'Username already exists'});
    const salt=crypto.randomBytes(16).toString('hex');
    await supa.from('users').insert({ username, pass_hash:hashPw(password,salt), pass_salt:salt, role: role==='admin'?'admin':'user' });
    res.json({ok:true});
  }catch(e){ res.status(500).json({error:String(e.message||e)}); }
});
app.post('/api/users/reset', auth, adminOnly, async (req,res)=>{
  try{ const { username, password } = req.body||{};
    if(!username||!password) return res.status(400).json({error:'username and password required'});
    if(String(password).length<4) return res.status(400).json({error:'Password must be at least 4 characters.'});
    const salt=crypto.randomBytes(16).toString('hex');
    const { data } = await supa.from('users').update({ pass_hash:hashPw(password,salt), pass_salt:salt }).eq('username',username).select('id');
    if(!data||!data.length) return res.status(404).json({error:'User not found'});
    res.json({ok:true});
  }catch(e){ res.status(500).json({error:String(e.message||e)}); }
});

// ---------- ingest (desktop, user token) ----------
app.post('/api/sync', auth, async (req,res)=>{
  try{
    const uid=req.user.uid; const b=req.body||{};
    const deviceId=String(b.deviceId||'').slice(0,200); if(!deviceId) return res.status(400).json({error:'deviceId required'});
    const now=new Date().toISOString();
    await supa.from('devices').upsert({ id:deviceId, user_id:uid, label:String(b.label||'').slice(0,200), last_seen:now,
      running:!!(b.status&&b.status.running), today_seconds:Math.round((b.status&&b.status.todaySeconds)||0) }, { onConflict:'id' });
    if(Array.isArray(b.days)&&b.days.length){
      const keys=b.days.map(d=>d.date);
      const { data:existing } = await supa.from('daily_stats').select('day,seconds,deleted').eq('device_id',deviceId).in('day',keys);
      const ex={}; (existing||[]).forEach(r=>ex[r.day]=r);
      const rows=b.days.map(d=>({ device_id:deviceId, user_id:uid, day:d.date,
        seconds:Math.max(Math.round(d.seconds||0),(ex[d.date]&&ex[d.date].seconds)||0),
        deleted:Math.max(Math.round(d.deleted||0),(ex[d.date]&&ex[d.date].deleted)||0),
        active_pct:Math.round(d.activePct||0) }));
      await supa.from('daily_stats').upsert(rows,{onConflict:'device_id,day'});
    }
    if(Array.isArray(b.apps)&&b.apps.length){
      const rows=b.apps.map(a=>({ device_id:deviceId, user_id:uid, app:String(a.app||'Unknown').slice(0,200), seconds:Math.round(a.seconds||0), updated_at:now }));
      await supa.from('app_usage').upsert(rows,{onConflict:'device_id,app'});
    }
    let inserted=0;
    if(Array.isArray(b.visits)&&b.visits.length){
      const rows=b.visits.slice(0,2000).map(v=>({ device_id:deviceId, user_id:uid, ts:v.t, domain:v.domain, title:String(v.title||'').slice(0,200), url:String(v.url||'').slice(0,400), browser:v.browser }));
      const { error }=await supa.from('site_visits').upsert(rows,{onConflict:'device_id,ts,url',ignoreDuplicates:true});
      if(!error) inserted=rows.length;
    }
    res.json({ ok:true, device:deviceId, visits:inserted });
  }catch(e){ res.status(500).json({error:String(e.message||e)}); }
});

app.post('/api/screenshot', auth, async (req,res)=>{
  try{
    const uid=req.user.uid; const { deviceId, day, name, dataB64 } = req.body||{};
    if(!deviceId||!day||!name||!dataB64) return res.status(400).json({error:'missing fields'});
    const buf=Buffer.from(dataB64,'base64'); const key=`${uid}/${deviceId}/${day}/${name}`;
    const up=await supa.storage.from(BUCKET).upload(key,buf,{contentType:'image/jpeg',upsert:true});
    if(up.error) return res.status(500).json({error:up.error.message});
    purgeDeviceDays(uid,deviceId,day);
    res.json({ok:true});
  }catch(e){ res.status(500).json({error:String(e.message||e)}); }
});
async function purgeDeviceDays(uid,deviceId,keepDay){
  try{ const base=`${uid}/${deviceId}`;
    const { data:days }=await supa.storage.from(BUCKET).list(base,{limit:1000});
    for(const d of (days||[])){ if(!d.name||d.name===keepDay) continue;
      const { data:fl }=await supa.storage.from(BUCKET).list(`${base}/${d.name}`,{limit:1000});
      if(fl&&fl.length) await supa.storage.from(BUCKET).remove(fl.map(x=>`${base}/${d.name}/${x.name}`));
    }
  }catch(e){}
}

// ---------- data (scoped) ----------
app.get('/api/data', auth, async (req,res)=>{
  try{ const uid=await scopeUserId(req);
    const [devices,daily,apps,visits]=await Promise.all([
      supa.from('devices').select('*').eq('user_id',uid).order('last_seen',{ascending:false}),
      supa.from('daily_stats').select('*').eq('user_id',uid).order('day',{ascending:false}).limit(3000),
      supa.from('app_usage').select('*').eq('user_id',uid).order('seconds',{ascending:false}).limit(2000),
      supa.from('site_visits').select('device_id,ts,domain,title,browser').eq('user_id',uid).order('ts',{ascending:false}).limit(500)
    ]);
    res.json({ devices:devices.data||[], daily:daily.data||[], apps:apps.data||[], visits:visits.data||[] });
  }catch(e){ res.status(500).json({error:String(e.message||e)}); }
});
app.get('/api/storage', auth, async (req,res)=>{
  try{ const uid=await scopeUserId(req); let bytes=0,files=0;
    const { data:devs }=await supa.storage.from(BUCKET).list(uid,{limit:1000});
    for(const dv of (devs||[])){ if(!dv.name) continue;
      const { data:days }=await supa.storage.from(BUCKET).list(`${uid}/${dv.name}`,{limit:1000});
      for(const dy of (days||[])){ if(!dy.name) continue;
        const { data:fl }=await supa.storage.from(BUCKET).list(`${uid}/${dv.name}/${dy.name}`,{limit:1000});
        for(const f of (fl||[])){ files++; bytes+=(f.metadata&&f.metadata.size)||0; }
      }
    }
    const quota=(parseInt(process.env.STORAGE_QUOTA_MB,10)||1024)*1024*1024;
    res.json({ bytes, files, quota, remaining:Math.max(0,quota-bytes) });
  }catch(e){ res.json({bytes:0,files:0,quota:0,remaining:0,error:String(e.message||e)}); }
});
app.get('/api/shots', auth, async (req,res)=>{
  try{ const uid=await scopeUserId(req); const device=String(req.query.device||''); if(!device) return res.json({files:[]});
    const base=`${uid}/${device}`;
    const { data:days }=await supa.storage.from(BUCKET).list(base,{limit:1000});
    const dn=(days||[]).map(d=>d.name).filter(n=>/^\d{4}-\d{2}-\d{2}$/.test(n)).sort().reverse();
    if(!dn.length) return res.json({files:[]});
    const day=dn[0];
    const { data:fl }=await supa.storage.from(BUCKET).list(`${base}/${day}`,{limit:1000,sortBy:{column:'name',order:'desc'}});
    const out=[];
    for(const f of (fl||[]).slice(0,200)){ const { data:s }=await supa.storage.from(BUCKET).createSignedUrl(`${base}/${day}/${f.name}`,3600); if(s&&s.signedUrl) out.push({name:f.name,url:s.signedUrl}); }
    res.json({ day, files:out });
  }catch(e){ res.json({files:[],error:String(e.message||e)}); }
});
app.post('/api/delete-shots', auth, async (req,res)=>{
  try{ const uid=await scopeUserId(req); const device=String((req.query&&req.query.device)||(req.body&&req.body.device)||''); if(!device) return res.status(400).json({error:'device required'});
    const base=`${uid}/${device}`; let removed=0;
    const { data:days }=await supa.storage.from(BUCKET).list(base,{limit:1000});
    for(const dy of (days||[])){ if(!dy.name) continue;
      const { data:fl }=await supa.storage.from(BUCKET).list(`${base}/${dy.name}`,{limit:1000});
      if(fl&&fl.length){ await supa.storage.from(BUCKET).remove(fl.map(f=>`${base}/${dy.name}/${f.name}`)); removed+=fl.length; }
    }
    res.json({ok:true,removed});
  }catch(e){ res.status(500).json({error:String(e.message||e)}); }
});

// ---------- dashboard SPA ----------
app.get('/', (_q,res)=>res.type('html').send(fs.readFileSync(path.join(__dirname,'dashboard.html'),'utf8')));

app.listen(PORT, ()=>console.log(`test-app-backend (multi-user) on :${PORT}`));
