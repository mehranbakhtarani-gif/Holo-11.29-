// Staged snapshot of holoo-apex-api. Production deployment is intentionally separate.
import { createHmac, randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';
const ORIGINS=new Set(["https://mehranbakhtarani-gif.github.io"]);
const corsHeaders=origin=>{const h={"vary":"Origin"};if(ORIGINS.has(origin)){h["access-control-allow-origin"]=origin;h["access-control-allow-credentials"]="true"}return h};
const out=(d,s=200,o="")=>new Response(JSON.stringify(d),{status:s,headers:{"content-type":"application/json; charset=utf-8",...corsHeaders(o),"cache-control":"no-store"}});
const n=v=>{if(typeof v==="number"&&Number.isFinite(v))return v;if(typeof v!=="string")return 0;const p="۰۱۲۳۴۵۶۷۸۹",a="٠١٢٣٤٥٦٧٨٩";let s="";for(const c of v){let x=p.indexOf(c),y=a.indexOf(c);s+=x>=0?x:y>=0?y:c}let z=Number(s.replace(/[^0-9.-]/g,""));return Number.isFinite(z)?z:0};
async function rates(){const specs=[["USD","price_dollar_rl","دلار آمریکا","$"],["EUR","price_eur","یورو اروپا","€"],["AED","price_aed","درهم امارات","د.إ"],["CNY","price_cny","یوان چین","¥"]],items=[];try{const r=await fetch("https://call1.tgju.org/ajax.json",{headers:{"User-Agent":"Mozilla/5.0 (compatible; HolooApexERP/1.0)"},signal:AbortSignal.timeout(6000)});if(r.ok){const cur=(await r.json())?.current||{};for(const [code,key,name,symbol] of specs){const v=cur[key];if(!v)continue;const priceIrr=Math.round(n(v.p));if(priceIrr<=0)continue;const dt=String(v.dt||"").toLowerCase(),direction=dt==="high"?"up":dt==="low"?"down":"flat",d=Math.round(n(v.d)),p=Math.abs(n(v.dp));items.push({code,name,symbol,priceIrr,highIrr:Math.round(n(v.h))||undefined,lowIrr:Math.round(n(v.l))||undefined,changeIrr:direction==="down"?-Math.abs(d):Math.abs(d),changePercent:direction==="down"?-p:p,direction,updatedTime:String(v.t||v.ts||"")})}}}catch{}if(items.length<4){try{const r=await fetch("https://alanchand.com/currencies-price",{headers:{"User-Agent":"Mozilla/5.0 (compatible; HolooApexERP/1.0)"},signal:AbortSignal.timeout(6000)});if(r.ok){const html=await r.text(),existing=new Set(items.map(x=>x.code)),fallback=[["USD","usd","دلار آمریکا","$"],["EUR","eur","یورو اروپا","€"],["AED","aed","درهم امارات","د.إ"],["CNY","cny","یوان چین","¥"]];for(const [code,slug,name,symbol] of fallback){if(existing.has(code))continue;const idx=html.indexOf("currencies-price/"+slug);if(idx<0)continue;const chunk=html.slice(idx,idx+700).replace(/<[^>]+>/g," ").replace(/\s+/g," "),m=chunk.match(/([۰-۹0-9]{2,3}[,،][۰-۹0-9]{3})/);if(m){const toman=n(m[1]);if(toman>1000)items.push({code,name,symbol,priceIrr:Math.round(toman*10),changeIrr:0,changePercent:0,direction:"flat",updatedTime:new Date().toLocaleTimeString("fa-IR",{hour:"2-digit",minute:"2-digit"})})}}}}catch{}}if(!items.length)throw Error("no rates");return{fetchedAt:Date.now(),source:"بازار آزاد تهران (همگام با chand.app)",sourceUrl:"https://chand.app/",items}}
export default{async fetch(req,env,ctx){const u=new URL(req.url),origin=req.headers.get("Origin")||"",allow=ORIGINS.has(origin)?origin:"";if(origin&&!allow)return out({error:"Origin not allowed",code:"CORS_ORIGIN_DENIED"},403);if(req.method==="OPTIONS")return new Response(null,{status:204,headers:{...corsHeaders(origin),"access-control-allow-methods":"GET,POST,DELETE,OPTIONS","access-control-allow-headers":"Content-Type, Authorization, X-Requested-With"}});if(u.pathname==="/api/health")return out({status:"ok",service:"holoo-apex-cloudflare-worker",timestamp:new Date().toISOString()},200,allow);if(u.pathname==="/api/live-fx"){const cache=caches.default,key=new Request(new URL("/_cache/live-fx",req.url));if(u.searchParams.get("refresh")!=="1"){const hit=await cache.match(key);if(hit)return out({...await hit.json(),cached:true},200,allow)}try{const data=await rates();ctx.waitUntil(cache.put(key,new Response(JSON.stringify(data),{headers:{"content-type":"application/json","cache-control":"public, max-age=60"}})));return out({...data,cached:false},200,allow)}catch{const hit=await cache.match(key);if(hit)return out({...await hit.json(),cached:true,stale:true},200,allow);return out({error:"امکان دریافت لحظه‌ای نرخ ارز از سرور منبع وجود ندارد.",items:[]},502,allow)}}
if(u.pathname==="/api/supabase/status" && req.method==="GET"){
 const base=String(env.SUPABASE_URL||"").replace(/\/$/,"");
 const key=String(env.SUPABASE_SERVICE_ROLE_KEY||"");
 if(!base||!key)return out({configured:false,connected:false,tableReady:false,projectRef:null,tableName:"holoo_apex_workspaces",latencyMs:null,errorCode:"NOT_CONFIGURED"},200,allow);
 let projectRef=null; try{projectRef=new URL(base).hostname.split(".")[0]}catch{}
 const t=Date.now();
 try{
  const r=await fetch(base+"/rest/v1/holoo_apex_workspaces?select=owner_id&limit=1",{headers:{apikey:key,Authorization:"Bearer "+key},signal:AbortSignal.timeout(7000)});
  const latencyMs=Math.max(1,Date.now()-t);
  if(r.ok)return out({configured:true,connected:true,tableReady:true,keyRole:"service_role_or_secret",projectRef,tableName:"holoo_apex_workspaces",latencyMs,errorCode:null},200,allow);
  if(r.status===404||r.status===400)return out({configured:true,connected:true,tableReady:false,projectRef,tableName:"holoo_apex_workspaces",latencyMs,errorCode:"TABLE_MISSING"},200,allow);
  return out({configured:true,connected:false,tableReady:false,projectRef,tableName:"holoo_apex_workspaces",latencyMs,errorCode:r.status===401||r.status===403?"AUTH_FAILED":"HTTP_"+r.status},200,allow);
 }catch{return out({configured:true,connected:false,tableReady:false,projectRef,tableName:"holoo_apex_workspaces",latencyMs:null,errorCode:"NETWORK_UNREACHABLE"},200,allow)}
}
if(u.pathname==="/api/supabase/test" && req.method==="POST"){
 const started=Date.now(),base=String(env.SUPABASE_URL||"").replace(/\/$/,""),key=String(env.SUPABASE_SERVICE_ROLE_KEY||"");
 const checks=[];
 if(!base||!key)return out({ok:false,testedAt:new Date().toISOString(),totalLatencyMs:1,projectRef:null,serverRevision:0,backupCount:0,authSource:"disconnected",checks:[{id:"supabase_env",title:"تنظیمات اتصال Supabase",ok:false,latencyMs:1,detail:"متغیرهای Worker تنظیم نشده‌اند."}],error:"تنظیمات Supabase در Worker کامل نیست."},503,allow);
 let projectRef=null;try{projectRef=new URL(base).hostname.split(".")[0]}catch{}
 const t=Date.now();
 try{
  const r=await fetch(base+"/rest/v1/holoo_apex_workspaces?select=owner_id&limit=1",{headers:{apikey:key,Authorization:"Bearer "+key},signal:AbortSignal.timeout(7000)});
  const latency=Math.max(1,Date.now()-t),ok=r.ok;
  checks.push({id:"worker_env",title:"تنظیمات امن Cloudflare Worker",ok:true,latencyMs:1,detail:"هر دو متغیر اتصال در محیط Worker در دسترس هستند."});
  checks.push({id:"supabase_network",title:"ارتباط با Supabase REST API",ok:r.status!==401&&r.status!==403,latencyMs:latency,detail:ok?"پاسخ معتبر از Supabase دریافت شد.":r.status===404||r.status===400?"ارتباط برقرار است، اما جدول موردنیاز پیدا نشد.":"پاسخ HTTP "+r.status+" از Supabase."});
  const tableReady=ok;
  checks.push({id:"supabase_table",title:"جدول holoo_apex_workspaces",ok:tableReady,latencyMs:latency,detail:tableReady?"جدول قابل خواندن است.":"ساختار جدول یا دسترسی آن نیاز به بررسی دارد."});
  return out({ok:checks.every(x=>x.ok),testedAt:new Date().toISOString(),totalLatencyMs:Math.max(1,Date.now()-started),projectRef,serverRevision:0,backupCount:0,authSource:"disconnected",keyRole:"service_role_or_secret",networkReachable:r.status!==401&&r.status!==403,rlsWriteReady:false,checks,remediations:tableReady?[]:[{id:"table_or_permissions",severity:"critical",title:"جدول یا مجوزهای Supabase آماده نیست",summary:"جدول holoo_apex_workspaces باید در پروژه وجود داشته باشد و کلید Worker اجازه دسترسی داشته باشد.",steps:["وجود جدول holoo_apex_workspaces را در Supabase بررسی کنید.","ساختار ستون owner_id را بررسی کنید."]}]},200,allow);
 }catch(e){checks.push({id:"supabase_network",title:"ارتباط با Supabase REST API",ok:false,latencyMs:Math.max(1,Date.now()-t),detail:"ارتباط شبکه برقرار نشد."});return out({ok:false,testedAt:new Date().toISOString(),totalLatencyMs:Math.max(1,Date.now()-started),projectRef,serverRevision:0,backupCount:0,authSource:"disconnected",networkReachable:false,rlsWriteReady:false,checks,error:"ارتباط با Supabase برقرار نشد."},502,allow)}
}

const SESSION_TTL=30*24*60*60*1000,SESSION_COOKIE="holoo_sb_session";
const validWid=v=>typeof v==="string"&&/^[a-zA-Z0-9_-]{3,48}$/.test(v);
const sessionSecret=env=>String(env.SUPABASE_SESSION_SECRET||"").trim()||createHmac("sha256","holoo-apex-supabase-session-key-v1").update(String(env.SUPABASE_SERVICE_ROLE_KEY||"")).digest("hex");
const hashPasscode=pass=>{const saltHex=randomBytes(16).toString("hex");return{saltHex,hashHex:scryptSync(pass,saltHex,32).toString("hex")}};
const verifyPasscode=(pass,salt,hash)=>{try{const a=scryptSync(pass,salt,32),b=Buffer.from(hash,"hex");return a.length===b.length&&timingSafeEqual(a,b)}catch{return false}};
const signToken=(wid,env)=>{const exp=Date.now()+SESSION_TTL,payload=Buffer.from(JSON.stringify({wid,exp,v:1}),"utf8").toString("base64url"),sig=createHmac("sha256",sessionSecret(env)).update(payload).digest("base64url");return{token:"sbw1."+payload+"."+sig,expiresAt:new Date(exp).toISOString()}};
const verifyToken=(token,env)=>{try{if(typeof token!=="string"||token.length>4096)return null;const p=token.split(".");if(p.length!==3||p[0]!=="sbw1")return null;const sig=createHmac("sha256",sessionSecret(env)).update(p[1]).digest("base64url"),a=Buffer.from(p[2]),b=Buffer.from(sig);if(a.length!==b.length||!timingSafeEqual(a,b))return null;const data=JSON.parse(Buffer.from(p[1],"base64url").toString("utf8"));if(!validWid(data.wid)||!Number.isFinite(data.exp)||Date.now()>data.exp)return null;return{uid:"sbw_"+data.wid,workspaceId:data.wid,email:data.wid+"@supabase.local",authSource:"supabase_workspace"}}catch{return null}};
const authOwner=wid=>"__sb_auth__"+wid;
const sbBase=env=>{const u=String(env.SUPABASE_URL||"").trim(),key=String(env.SUPABASE_SERVICE_ROLE_KEY||"").trim();try{const p=new URL(u);if(p.protocol!=="https:"||!p.hostname.endsWith(".supabase.co")||!key)return null;return{base:p.origin,key,table:/^[a-z][a-z0-9_]{2,60}$/.test(String(env.SUPABASE_TABLE_NAME||""))?String(env.SUPABASE_TABLE_NAME):"holoo_apex_workspaces"}}catch{return null}};
const sbHeaders=(cfg,extra={})=>{const h={apikey:cfg.key,"content-type":"application/json",...extra};if(!cfg.key.startsWith("sb_secret_"))h.authorization="Bearer "+cfg.key;return h};
const readJson=async req=>{const len=Number(req.headers.get("content-length")||0);if(len>16384)throw Error("BODY_TOO_LARGE");return await req.json()};
const cookieToken=req=>{const raw=req.headers.get("cookie")||"";for(const part of raw.split(";")){const i=part.indexOf("=");if(i>0&&part.slice(0,i).trim()===SESSION_COOKIE){try{return decodeURIComponent(part.slice(i+1).trim())}catch{return part.slice(i+1).trim()}}}return null};
const actorFor=(req,env)=>{const h=req.headers.get("authorization")||"";const bearer=h.startsWith("Bearer ")?h.slice(7).trim():null;return (bearer&&verifyToken(bearer,env))||verifyToken(cookieToken(req)||"",env)};
const cookieHeader=token=>SESSION_COOKIE+"="+encodeURIComponent(token)+"; Path=/; Max-Age=2592000; HttpOnly; Secure; SameSite=None; Partitioned";
async function authRoutes(req,u,env,allow){
 const path=u.pathname,method=req.method;
 if(path==="/api/supabase/auth/state"&&method==="GET"){
  const wid=(u.searchParams.get("workspaceId")||"atlasris_main").trim();if(!validWid(wid))return out({error:"شناسه فضای کاری نامعتبر است."},400,allow);
  const cfg=sbBase(env);if(!cfg)return out({error:"Supabase در تنظیمات Worker پیکربندی نشده است.",code:"NOT_CONFIGURED"},503,allow);
  try{const r=await fetch(cfg.base+"/rest/v1/"+cfg.table+"?owner_id=eq."+encodeURIComponent(authOwner(wid))+"&select=owner_id&limit=1",{headers:sbHeaders(cfg),signal:AbortSignal.timeout(6000)});if(!r.ok)return out({error:"خطا در بررسی وضعیت حساب مستقل Supabase."},r.status,allow);const rows=await r.json();return out({workspaceId:wid,initialized:Array.isArray(rows)&&rows.length>0},200,allow)}catch{return out({error:"ارتباط با Supabase برقرار نشد."},502,allow)}
 }
 if((path==="/api/supabase/auth/setup"||path==="/api/supabase/auth/login")&&method==="POST"){
  if(req.headers.get("x-requested-with")!=="HolooApex")return out({error:"درخواست نامعتبر است (محافظ CSRF)."},403,allow);
  const cfg=sbBase(env);if(!cfg)return out({error:"Supabase در تنظیمات Worker پیکربندی نشده است.",code:"NOT_CONFIGURED"},503,allow);
  if(cfg.key.startsWith("sb_publishable_")||cfg.key.startsWith("eyJ")&&(()=>{try{return JSON.parse(Buffer.from(cfg.key.split(".")[1],"base64url").toString()).role!=="service_role"}catch{return true}})())return out({error:"کلید Worker مجوز نوشتن امن ندارد.",code:"INVALID_ANON_KEY"},403,allow);
  let body;try{body=await readJson(req)}catch{return out({error:"بدنه درخواست نامعتبر یا بیش از حد بزرگ است."},400,allow)}
  const wid=String(body?.workspaceId||"").trim(),pass=String(body?.passcode||"");if(!validWid(wid)||pass.length<6||pass.length>128)return out({error:"شناسه فضای کاری یا رمز عبور معتبر نیست."},400,allow);
  const owner=authOwner(wid),url=cfg.base+"/rest/v1/"+cfg.table+"?owner_id=eq."+encodeURIComponent(owner)+"&select=snapshot_json&limit=1";
  try{
   const check=await fetch(url,{headers:sbHeaders(cfg),signal:AbortSignal.timeout(6000)});if(!check.ok)return out({error:"خطا در بررسی اطلاعات فضای کاری."},check.status,allow);
   const rows=await check.json();const existing=rows?.[0]?.snapshot_json;
   if(path.endsWith("/setup")){
    if(Array.isArray(rows)&&rows.length)return out({error:"این فضای کاری قبلاً فعال شده است. با رمز ثبت‌شده وارد شوید."},409,allow);
    const {saltHex,hashHex}=hashPasscode(pass),now=new Date().toISOString();
    const create=await fetch(cfg.base+"/rest/v1/"+cfg.table,{method:"POST",headers:sbHeaders(cfg,{Prefer:"return=minimal"}),body:JSON.stringify({owner_id:owner,owner_email:wid+"@supabase.local",company_name:"Workspace Auth ("+wid+")",fiscal_year:"1405",revision:1,conflict_policy:"last_write_wins",last_device_id:"auth_setup",last_device_label:"Supabase Independent Auth",voucher_count:0,invoice_count:0,product_count:0,snapshot_json:{kind:"supabase_workspace_auth_v1",workspaceId:wid,saltHex,hashHex,createdAt:now},client_updated_at:now,updated_at:now}),signal:AbortSignal.timeout(8000)});
    if(!create.ok){const t=await create.text();const m=t.match(/"code"\s*:\s*"([A-Z0-9_]+)"/);const c=m?.[1]||"HTTP_"+create.status;return out({error:"فعال‌سازی فضای کاری انجام نشد.",code:c},create.status===409?409:create.status,allow)}
   }else{
    const authObj=typeof existing==="string"?JSON.parse(existing):existing;if(!authObj?.saltHex||!authObj?.hashHex)return out({error:"این فضای کاری هنوز فعال نشده است."},404,allow);
    if(!verifyPasscode(pass,authObj.saltHex,authObj.hashHex))return out({error:"رمز عبور فضای کاری اشتباه است."},401,allow);
   }
   const signed=signToken(wid,env);let currentRevision=0,currentUpdatedAt=null;
   try{const rev=await fetch(cfg.base+"/rest/v1/"+cfg.table+"?owner_id=eq."+encodeURIComponent("sbw_"+wid)+"&select=revision,updated_at&limit=1",{headers:sbHeaders(cfg),signal:AbortSignal.timeout(5000)});if(rev.ok){const rr=await rev.json();if(rr?.[0]){currentRevision=Number(rr[0].revision)||0;currentUpdatedAt=rr[0].updated_at||null}}}catch{}
   return new Response(JSON.stringify({ok:true,workspaceId:wid,token:signed.token,expiresAt:signed.expiresAt,currentRevision,currentUpdatedAt}),{status:200,headers:{"content-type":"application/json; charset=utf-8",...corsHeaders(allow),"cache-control":"no-store","set-cookie":cookieHeader(signed.token)}});
  }catch(e){return out({error:"ارتباط با Supabase برقرار نشد."},502,allow)}
 }
 if(path==="/api/supabase/auth/me"&&method==="GET"){
  const actor=actorFor(req,env);if(!actor)return out({authenticated:false,workspaceId:null,serverRevision:0,updatedAt:null,backupCount:0},200,allow);
  const cfg=sbBase(env);let serverRevision=0,updatedAt=null,backupCount=0;
  if(cfg){try{const r=await fetch(cfg.base+"/rest/v1/"+cfg.table+"?owner_id=eq."+encodeURIComponent(actor.uid)+"&select=revision,updated_at&limit=1",{headers:sbHeaders(cfg),signal:AbortSignal.timeout(6000)});if(r.ok){const rows=await r.json();if(rows?.[0]){serverRevision=Number(rows[0].revision)||0;updatedAt=rows[0].updated_at||null}}const b=await fetch(cfg.base+"/rest/v1/"+cfg.table+"?owner_id=like."+encodeURIComponent(actor.uid+"__bak__")+"*&select=owner_id&limit=3",{headers:sbHeaders(cfg),signal:AbortSignal.timeout(6000)});if(b.ok)backupCount=(await b.json()).length}catch{}}
  return out({authenticated:true,authSource:"supabase_workspace",workspaceId:actor.workspaceId,serverRevision,updatedAt,backupCount},200,allow);
 }
 if(path==="/api/supabase/auth/logout"&&method==="POST"){
  if(req.headers.get("x-requested-with")!=="HolooApex")return out({error:"درخواست خروج معتبر نیست."},403,allow);
  return new Response(JSON.stringify({ok:true}),{status:200,headers:{"content-type":"application/json; charset=utf-8",...corsHeaders(allow),"set-cookie":SESSION_COOKIE+"=; Path=/; Max-Age=0; HttpOnly; Secure; SameSite=None; Partitioned"}});
 }
 return null;
}

const authResponse=await authRoutes(req,u,env,allow);if(authResponse)return authResponse;

if(u.pathname==="/api/supabase/pull"&&req.method==="GET"){
 const actor=actorFor(req,env);
 if(!actor||!validWid(actor.workspaceId))return out({error:"برای خواندن از Supabase ابتدا اتصال مستقل را فعال کنید.",code:"AUTH_REQUIRED"},401,allow);
 const requested=u.searchParams.get("backupId")||"";
 const prefix=actor.uid+"__bak__";
 let target=actor.uid;
 if(requested){if(requested.length>180||!requested.startsWith(prefix)||!/^[a-zA-Z0-9_-]{8,200}$/.test(requested))return out({error:"دسترسی به این نسخه پشتیبان مجاز نیست."},403,allow);target=requested}
 const cfg=sbBase(env);if(!cfg)return out({error:"Supabase در تنظیمات Worker پیکربندی نشده است.",code:"NOT_CONFIGURED"},503,allow);
 try{
  const url=cfg.base+"/rest/v1/"+cfg.table+"?owner_id=eq."+encodeURIComponent(target)+"&select=revision,conflict_policy,last_device_id,last_device_label,updated_at,snapshot_json&limit=1";
  const r=await fetch(url,{headers:sbHeaders(cfg),signal:AbortSignal.timeout(8000)});
  if(!r.ok)return out({error:"خطا در بازیابی اطلاعات از Supabase.",code:"PULL_READ_FAILED"},r.status,allow);
  const rows=await r.json(),row=rows?.[0];
  if(!row||!row.snapshot_json)return out({found:false,revision:0},200,allow);
  return out({found:true,backupId:requested||undefined,revision:Number(row.revision)||1,conflictPolicy:row.conflict_policy||"last_write_wins",lastDeviceId:row.last_device_id||"",lastDeviceLabel:row.last_device_label||"",updatedAt:row.updated_at||new Date().toISOString(),snapshotJson:typeof row.snapshot_json==="string"?row.snapshot_json:JSON.stringify(row.snapshot_json)},200,allow);
 }catch{return out({error:"ارتباط با سرور Supabase برقرار نشد.",code:"PULL_NETWORK_ERROR"},502,allow)}
}

if(u.pathname==="/api/supabase/sync"&&req.method==="POST"){
 const actor=actorFor(req,env);
 if(!actor||!validWid(actor.workspaceId))return out({error:"احراز هویت مستقل Supabase برای همگام‌سازی الزامی است.",code:"AUTH_REQUIRED"},401,allow);
 const cfg=sbBase(env);if(!cfg)return out({error:"Supabase در تنظیمات Worker پیکربندی نشده است.",code:"NOT_CONFIGURED"},503,allow);
 if(cfg.key.startsWith("sb_publishable_")||cfg.key.startsWith("eyJ")&&(()=>{try{return JSON.parse(Buffer.from(cfg.key.split(".")[1],"base64url").toString()).role!=="service_role"}catch{return true}})())return out({error:"کلید Worker مجوز نوشتن امن ندارد.",code:"INVALID_ANON_KEY"},403,allow);
 let raw;try{raw=await req.text()}catch{return out({error:"بدنه درخواست قابل خواندن نیست."},400,allow)}
 if(raw.length>6_200_000)return out({error:"حجم داده بیش از حد مجاز است."},413,allow);
 let body;try{body=JSON.parse(raw)}catch{return out({error:"بدنه JSON نامعتبر است."},400,allow)}
 const op=typeof body.operationId==="string"?body.operationId.trim():"";
 const operationId=/^[a-zA-Z0-9_-]{8,120}$/.test(op)?op:"";
 const conflictPolicy=body.conflictPolicy==="first_write_wins"?"first_write_wins":"last_write_wins";
 const deviceId=String(body.deviceId||"unknown").slice(0,64),deviceLabel=String(body.deviceLabel||"دستگاه کاری").slice(0,80);
 const clientRevision=Math.max(0,Math.floor(Number(body.clientRevision)||0));
 const clientUpdatedAt=typeof body.clientUpdatedAt==="string"&&!Number.isNaN(Date.parse(body.clientUpdatedAt))?body.clientUpdatedAt:new Date().toISOString();
 if(typeof body.snapshotJson!=="string"||!body.snapshotJson.length)return out({error:"محتوای اسنپ‌شات برای همگام‌سازی خالی است."},400,allow);
 if(body.snapshotJson.length>6_000_000)return out({error:"حجم اسنپ‌شات بیش از حد مجاز است."},413,allow);
 let snapshot;try{snapshot=JSON.parse(body.snapshotJson,(k,v)=>["__proto__","constructor","prototype"].includes(k)?undefined:v);if(!snapshot||typeof snapshot!=="object"||Array.isArray(snapshot))throw Error()}catch{return out({error:"فرمت JSON اسنپ‌شات نامعتبر است."},400,allow)}
 const base=cfg.base+"/rest/v1/"+cfg.table,owner=actor.uid,query=base+"?owner_id=eq."+encodeURIComponent(owner)+"&select=owner_id,revision,last_device_id,last_device_label,updated_at,snapshot_json&limit=1";
 const readCurrent=async()=>{const r=await fetch(query,{headers:sbHeaders(cfg),signal:AbortSignal.timeout(8000)});if(!r.ok)throw Error("READ_"+r.status);const rows=await r.json();return rows?.[0]||null};
 const audit=async(outcome,rev,details)=>{try{await fetch(cfg.base+"/rest/v1/"+String(env.SUPABASE_AUDIT_TABLE_NAME||"holoo_apex_audit_log"),{method:"POST",headers:sbHeaders(cfg,{Prefer:"return=minimal"}),body:JSON.stringify({owner_id:owner,device_id:deviceId,device_label:deviceLabel,action:"workspace_sync",conflict_policy:conflictPolicy,client_revision:clientRevision,server_revision:rev,outcome,details:String(details).slice(0,300)}),signal:AbortSignal.timeout(4000)})}catch{}};
 const backupMeta=async()=>{try{const prefix=owner+"__bak__",url=base+"?owner_id=like."+encodeURIComponent(prefix+"*")+"&select=owner_id,revision,company_name,fiscal_year,last_device_label,voucher_count,invoice_count,product_count,updated_at,created_at&order=created_at.desc&limit=30";const r=await fetch(url,{headers:sbHeaders(cfg),signal:AbortSignal.timeout(7000)});if(!r.ok)return{backups:[],prunedBackupsCount:0};const rows=(await r.json()).filter(x=>typeof x.owner_id==="string"&&x.owner_id.startsWith(prefix)).sort((a,b)=>String(b.created_at||b.updated_at||"").localeCompare(String(a.created_at||a.updated_at||"")));let prunedBackupsCount=0;for(const old of rows.slice(3)){const d=await fetch(base+"?owner_id=eq."+encodeURIComponent(old.owner_id),{method:"DELETE",headers:sbHeaders(cfg,{Prefer:"return=minimal"}),signal:AbortSignal.timeout(5000)});if(d.ok)prunedBackupsCount++}return{backups:rows.slice(0,3).map(x=>({id:x.owner_id,provider:"supabase",revision:Number(x.revision)||1,savedAt:x.created_at||x.updated_at||new Date().toISOString(),deviceLabel:x.last_device_label||"دستگاه کاری",companyName:x.company_name||"",fiscalYear:x.fiscal_year||"1405",voucherCount:Number(x.voucher_count)||0,invoiceCount:Number(x.invoice_count)||0,productCount:Number(x.product_count)||0})),prunedBackupsCount}}catch{return{backups:[],prunedBackupsCount:0}}};
 try{
  let existing=await readCurrent(),serverRev=Number(existing?.revision)||0;
  const oldSnapshot=existing?.snapshot_json;
  const lastOp=oldSnapshot&&typeof oldSnapshot==="object"?oldSnapshot._syncMeta?.lastOperationId:null;
  if(operationId&&lastOp===operationId){const b=await backupMeta();return out({status:"idempotent_replay",idempotentReplay:true,operationId,serverRevision:serverRev,conflictPolicy,syncedAt:existing.updated_at||new Date().toISOString(),retainedBackups:b.backups,prunedBackupsCount:0},200,allow)}
  const hasConflict=!!existing&&serverRev>clientRevision&&existing.last_device_id!==deviceId;
  if(hasConflict&&conflictPolicy==="first_write_wins"){
   await audit("conflict_kept_remote",serverRev,"First-Write-Wins preserved remote revision "+serverRev);
   const b=await backupMeta();
   return out({status:"conflict_kept_remote",serverRevision:serverRev,conflictPolicy,remoteDeviceLabel:existing.last_device_label||"دستگاه دیگر",syncedAt:existing.updated_at||new Date().toISOString(),retainedBackups:b.backups,prunedBackupsCount:b.prunedBackupsCount,remoteSnapshotJson:typeof oldSnapshot==="string"?oldSnapshot:JSON.stringify(oldSnapshot)},200,allow)
  }
  const nextRevision=Math.max(serverRev,clientRevision)+1,now=new Date().toISOString();
  const snapshotWithMeta=operationId?{...snapshot,_syncMeta:{lastOperationId:operationId,revision:nextRevision,deviceId,syncedAt:now}}:snapshot;
  const payload={owner_id:owner,owner_email:String(actor.email||"").slice(0,200),company_name:String(body.companyName||"").slice(0,160),fiscal_year:String(body.fiscalYear||"1405").slice(0,16),revision:nextRevision,conflict_policy:conflictPolicy,last_device_id:deviceId,last_device_label:deviceLabel,voucher_count:Math.max(0,Math.floor(Number(body.voucherCount)||0)),invoice_count:Math.max(0,Math.floor(Number(body.invoiceCount)||0)),product_count:Math.max(0,Math.floor(Number(body.productCount)||0)),snapshot_json:snapshotWithMeta,client_updated_at:clientUpdatedAt,updated_at:now};
  if(existing&&conflictPolicy==="first_write_wins"){
   const cas=await fetch(base+"?owner_id=eq."+encodeURIComponent(owner)+"&revision=eq."+serverRev,{method:"PATCH",headers:sbHeaders(cfg,{Prefer:"return=representation"}),body:JSON.stringify(payload),signal:AbortSignal.timeout(10000)});
   if(!cas.ok)return out({error:"خطا در ثبت همزمان نسخه روی Supabase.",code:"CAS_WRITE_FAILED"},cas.status,allow);
   const rows=await cas.json();
   if(!Array.isArray(rows)||!rows.length){const winner=await readCurrent()||existing;const rev=Number(winner.revision)||serverRev;await audit("conflict_kept_remote",rev,"Atomic CAS preserved concurrent revision "+rev);const b=await backupMeta();return out({status:"conflict_kept_remote",serverRevision:rev,conflictPolicy,remoteDeviceLabel:winner.last_device_label||"دستگاه دیگر",syncedAt:winner.updated_at||now,retainedBackups:b.backups,prunedBackupsCount:b.prunedBackupsCount,remoteSnapshotJson:typeof winner.snapshot_json==="string"?winner.snapshot_json:JSON.stringify(winner.snapshot_json)},200,allow)}
  }else{
   const up=await fetch(base+"?on_conflict=owner_id",{method:"POST",headers:sbHeaders(cfg,{Prefer:"resolution=merge-duplicates,return=minimal"}),body:JSON.stringify(payload),signal:AbortSignal.timeout(10000)});
   if(!up.ok)return out({error:"خطا در ذخیره نسخه روی Supabase.",code:"UPSERT_FAILED"},up.status,allow)
  }
  const backupKey=owner+"__bak__"+Date.now()+"_"+nextRevision;
  try{await fetch(base,{method:"POST",headers:sbHeaders(cfg,{Prefer:"return=minimal"}),body:JSON.stringify({...payload,owner_id:backupKey,created_at:now}),signal:AbortSignal.timeout(8000)})}catch{}
  const b=await backupMeta(),outcome=hasConflict?"conflict_overwrote_remote":"synced";
  await audit(outcome,nextRevision,"Synced revision "+nextRevision+" from "+deviceLabel);
  return out({status:outcome,operationId:operationId||undefined,serverRevision:nextRevision,conflictPolicy,syncedAt:now,retainedBackups:b.backups,prunedBackupsCount:b.prunedBackupsCount},200,allow);
 }catch{return out({error:"ارتباط با سرور Supabase برقرار نشد.",code:"SUPABASE_SYNC_FAILED"},502,allow)}
}

if(u.pathname==="/api/supabase/backups"&&req.method==="GET"){
 const actor=actorFor(req,env);
 if(!actor||!validWid(actor.workspaceId))return out({error:"برای مشاهده نسخه‌های پشتیبان ابتدا وارد شوید.",code:"AUTH_REQUIRED"},401,allow);
 const cfg=sbBase(env);if(!cfg)return out({error:"Supabase در تنظیمات Worker پیکربندی نشده است.",code:"NOT_CONFIGURED"},503,allow);
 const prefix=actor.uid+"__bak__";
 try{
  const url=cfg.base+"/rest/v1/"+cfg.table+"?owner_id=like."+encodeURIComponent(prefix+"*")+"&select=owner_id,revision,company_name,fiscal_year,last_device_label,voucher_count,invoice_count,product_count,created_at,updated_at&order=created_at.desc&limit=100";
  const r=await fetch(url,{headers:sbHeaders(cfg),signal:AbortSignal.timeout(8000)});
  if(!r.ok)return out({error:"دریافت فهرست نسخه‌های پشتیبان ناموفق بود.",code:"BACKUP_LIST_FAILED"},r.status,allow);
  const rows=(await r.json()).filter(x=>typeof x.owner_id==="string"&&x.owner_id.startsWith(prefix));
  const backups=rows.map(x=>({id:x.owner_id,provider:"supabase",revision:Number(x.revision)||1,savedAt:x.created_at||x.updated_at||null,deviceLabel:x.last_device_label||"دستگاه کاری",companyName:x.company_name||"",fiscalYear:x.fiscal_year||"1405",voucherCount:Number(x.voucher_count)||0,invoiceCount:Number(x.invoice_count)||0,productCount:Number(x.product_count)||0}));
  return out({backups,backupCount:backups.length},200,allow);
 }catch{return out({error:"ارتباط با Supabase برای دریافت فهرست پشتیبان برقرار نشد.",code:"BACKUP_LIST_NETWORK_ERROR"},502,allow)}
}
if(u.pathname==="/api/supabase/backups"&&req.method==="DELETE"){
 const actor=actorFor(req,env);
 if(!actor||!validWid(actor.workspaceId))return out({error:"برای حذف نسخه پشتیبان ابتدا وارد شوید.",code:"AUTH_REQUIRED"},401,allow);
 const backupId=String(u.searchParams.get("backupId")||"");
 const prefix=actor.uid+"__bak__";
 if(backupId.length>180||!backupId.startsWith(prefix)||!new RegExp("^"+prefix.replace(/[.*+?^${}()|[\]\\]/g,"\\if(u.pathname.startsWith("/api/ai/")||u.pathname.startsWith("/api/supabase/"))")+"[a-zA-Z0-9_-]{8,80}$").test(backupId))return out({error:"شناسه نسخه پشتیبان نامعتبر است یا به این فضای کاری تعلق ندارد.",code:"BACKUP_FORBIDDEN"},403,allow);
 const cfg=sbBase(env);if(!cfg)return out({error:"Supabase در تنظیمات Worker پیکربندی نشده است.",code:"NOT_CONFIGURED"},503,allow);
 try{
  const url=cfg.base+"/rest/v1/"+cfg.table+"?owner_id=eq."+encodeURIComponent(backupId);
  const r=await fetch(url,{method:"DELETE",headers:sbHeaders(cfg,{Prefer:"return=representation"}),signal:AbortSignal.timeout(8000)});
  if(!r.ok)return out({error:"حذف نسخه پشتیبان از Supabase ناموفق بود.",code:"BACKUP_DELETE_FAILED"},r.status,allow);
  const deleted=await r.json().catch(()=>[]);
  if(!Array.isArray(deleted)||deleted.length===0)return out({deleted:false,error:"نسخه پشتیبان پیدا نشد.",code:"BACKUP_NOT_FOUND"},404,allow);
  return out({deleted:true,backupId},200,allow);
 }catch{return out({error:"ارتباط با Supabase برای حذف نسخه پشتیبان برقرار نشد.",code:"BACKUP_DELETE_NETWORK_ERROR"},502,allow)}
}

if(u.pathname.startsWith("/api/ai/")||u.pathname.startsWith("/api/supabase/"))return out({error:"این API هنوز به Worker منتقل نشده است.",code:"API_NOT_MIGRATED"},501,allow);return out({error:"Not found"},404,allow)}};
