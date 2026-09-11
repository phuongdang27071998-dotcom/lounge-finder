import express from 'express';
import cors from 'cors';
import cron from 'node-cron';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { searchAirports, getAirport, getLounges, recentSyncRuns, listAirportCodes } from './db.js';
import { syncAirport, fastSyncAirport, translateCachedAirport, searchSourceAirports, discoverAirportIndex } from './scraper.js';
import { evaluateOpeningHours } from './hours.js';
import { seed } from './seed.js';

seed();
const app=express(); app.use(cors()); app.use(express.json());
const __dirname=path.dirname(fileURLToPath(import.meta.url));
app.use(express.static(path.resolve(__dirname,'../public'),{setHeaders:(res)=>{res.setHeader('Cache-Control','no-store, no-cache, must-revalidate');res.setHeader('Pragma','no-cache');res.setHeader('Expires','0');}}));
const staleHours=Number(process.env.STALE_HOURS||process.env.CACHE_MAX_HOURS||24);
const autoRefreshOnSearch=process.env.AUTO_REFRESH_ON_SEARCH!=='0';
const refreshInFlight=new Map();
const terminalIndexCheckedAt=new Map();
const airportSourceCache=new Map();
const translateInFlight=new Map();
const AIRPORT_SOURCE_CACHE_MS=10*60*1000;
const isStale=a=>!a || (Date.now()-new Date(a.updated_at).getTime()) > staleHours*3600000;
const withTimeout=(promise,ms,label='Tác vụ')=>Promise.race([promise,new Promise((_,rej)=>setTimeout(()=>rej(new Error(`${label} quá thời gian ${Math.round(ms/1000)} giây`)),ms))]);

function loungeHasDetail(l){
  if(!l) return false;
  if(String(l.opening_en||'').trim() || String(l.location_en||'').trim() || String(l.conditions_en||'').trim()) return true;
  if(String(l.full_detail_en||'').trim()) return true;
  const sections=l.source_sections&&typeof l.source_sections==='object'?l.source_sections:{};
  return Object.values(sections).some(v=>String(v||'').trim());
}
function cacheNeedsRepair(lounges=[]){
  if(!lounges.length) return true;
  const complete=lounges.filter(loungeHasDetail).length;
  // Terminal discovery in V29/V30 could leave all lounges as index-only stubs.
  // Repair when there are no real detail rows, or when most rows are still empty.
  return complete===0 || complete/lounges.length<0.6;
}

function viFieldBroken(en,vi){
  const a=String(en||'').trim(); const b=String(vi||'').trim();
  if(!a) return false;
  if(!b) return true;
  if(a.length>30 && a.toLowerCase()===b.toLowerCase()) return true;
  return false;
}
function cacheNeedsViRepair(lounges=[]){
  if(!lounges.length) return false;
  let broken=0, checked=0;
  for(const l of lounges){
    for(const [en,vi] of [[l.opening_en,l.opening_vi],[l.location_en,l.location_vi],[l.conditions_en,l.conditions_vi],[l.notes_en,l.notes_vi],[l.additional_en,l.additional_vi]]){
      if(String(en||'').trim()){ checked++; if(viFieldBroken(en,vi)) broken++; }
    }
  }
  for(const l of lounges){
    const sections=l.source_sections&&typeof l.source_sections==='object'?l.source_sections:{};
    const viSections=l.source_sections_vi&&typeof l.source_sections_vi==='object'?l.source_sections_vi:{};
    for(const [title,value] of Object.entries(sections)){
      if(!String(value||'').trim()) continue;
      const v=viSections[title]?.value_vi;
      if(!String(v||'').trim()) broken++;
      checked++;
    }
  }
  return checked>0 && broken>0;
}

async function syncAirportWithRetry(code,attempts=2){
  let last;
  for(let i=0;i<attempts;i++){
    try{return await syncAirport(code);}
    catch(e){last=e;if(i<attempts-1) await new Promise(r=>setTimeout(r,900));}
  }
  throw last;
}


function effectiveTerminal(l){
  if(l.terminal) return l.terminal;
  const text=`${l.name_en||''} ${l.location_en||''} ${l.conditions_en||''} ${l.notes_en||''} ${l.additional_en||''} ${l.full_detail_en||''} ${JSON.stringify(l.source_sections||{})}`;
  let m=text.match(/\bTerminal\s*(?:No\.?|Number)?\s*[-:]?\s*([0-9]{1,2}|[A-Z])\b/i);
  if(m) return `Terminal ${String(m[1]).toUpperCase()}`;
  if(/\binternational\s+(?:departures?|arrivals?|terminal|area|concourse)\b/i.test(text) || l.access_scope==='international') return 'International Terminal';
  if(/\bdomestic\s+(?:departures?|arrivals?|terminal|area|concourse)\b/i.test(text) || l.access_scope==='domestic') return 'Domestic Terminal';
  m=text.match(/\bConcourse\s+([A-Z0-9]{1,3})\b/i); if(m) return `Concourse ${m[1].toUpperCase()}`;
  return '';
}
function hydrateTerminal(l){const t=effectiveTerminal(l);return t===l.terminal?l:{...l,terminal:t};}

function translateAirportInBackground(code){
  if(translateInFlight.has(code)) return translateInFlight.get(code);
  const p=translateCachedAirport(code).catch(e=>console.error('background translate failed',code,e.message)).finally(()=>translateInFlight.delete(code));
  translateInFlight.set(code,p); return p;
}
function refreshAirportInBackground(code){
  if(refreshInFlight.has(code)) return refreshInFlight.get(code);
  const p=syncAirportWithRetry(code,2).catch(e=>console.error('background sync failed',code,e.message)).finally(()=>refreshInFlight.delete(code));
  refreshInFlight.set(code,p); return p;
}
app.get('/api/health',(req,res)=>res.json({ok:true,version:'37.0.0',source:process.env.SOURCE_URL||'https://loungefinder.loungekey.com/en/linkcarevn/',time:new Date().toISOString()}));
app.get('/api/airports',async(req,res)=>{
  const q=String(req.query.q||'').trim(); const cached=searchAirports(q);
  if(cached.length || q.length<2 || req.query.source==='0') return res.json(cached);
  const key=q.toLowerCase();
  const hit=airportSourceCache.get(key);
  if(hit && Date.now()-hit.at<AIRPORT_SOURCE_CACHE_MS) return res.json(hit.items);
  try{
    const items=await searchSourceAirports(q);
    airportSourceCache.set(key,{at:Date.now(),items});
    return res.json(items);
  }catch{ return res.json(cached); }
});

app.get('/api/terminal-options',async(req,res)=>{
  const code=String(req.query.airport||'').trim().toUpperCase();
  if(!/^[A-Z]{3}$/.test(code)) return res.status(400).json({error:'Vui lòng nhập mã sân bay IATA gồm 3 ký tự.'});
  const build=()=>{
    const a=getAirport(code);
    const ls=getLounges(code).map(hydrateTerminal);
    const terminals=[...new Set([
      ...((a&&Array.isArray(a.terminals))?a.terminals:[]),
      ...ls.map(x=>x.terminal).filter(Boolean)
    ])].sort((x,y)=>x.localeCompare(y,undefined,{numeric:true}));
    return {airport:a,terminals,hasUnknown:ls.some(x=>!x.terminal),loungeCount:ls.length};
  };
  let data=build(); let refreshed=false; let refreshError='';
  // Fast terminal discovery reads only the airport lounge index page (one page),
  // so the search screen can offer Terminal 1/2/S1 before the full lounge sync.
  const indexAge=Date.now()-(terminalIndexCheckedAt.get(code)||0);
  const shouldCheck=req.query.refresh!=='0' && (indexAge>6*3600000 || !data.terminals.length || data.hasUnknown);
  if(shouldCheck){
    try{await discoverAirportIndex(code);terminalIndexCheckedAt.set(code,Date.now());refreshed=true;data=build();}
    catch(e){refreshError=e.message;data=build();}
  }
  res.json({...data,refreshed,refreshError});
});

app.get('/api/search',async(req,res)=>{
  // V37: one hard interactive deadline. The response is sent only after EN data
  // and its VI translation are both ready, or the request fails before 60 seconds.
  const deadlineAt=Date.now()+55000;
  const remaining=()=>Math.max(0,deadlineAt-Date.now());
  const code=String(req.query.airport||'').trim().toUpperCase();
  if(!/^[A-Z]{3}$/.test(code)) return res.status(400).json({error:'Vui lòng nhập mã sân bay IATA gồm 3 ký tự.'});
  let a=getAirport(code); let refreshError='';
  let cachedLounges=getLounges(code);
  const firstLookup=!a || !cachedLounges.length;
  const repairIncompleteCache=cacheNeedsRepair(cachedLounges);
  const repairViCache=cacheNeedsViRepair(cachedLounges);
  let refreshed=false;
  // Fast cache strategy: first lookup waits for source; subsequent searches return cache immediately.
  // Stale data refreshes in background so the user is never blocked by LoungeKey on normal searches.
  let hydrating=false;
  if(firstLookup || repairIncompleteCache){
    // V36: hard response budget. Direct HTTP detail sync gets at most 38s.
    // Never block an interactive search on Playwright; robust repair continues in background.
    try{
      await withTimeout(fastSyncAirport(code,{translate:false}),Math.min(36000,Math.max(1000,remaining()-16000)),'Đồng bộ LoungeKey');
      a=getAirport(code); cachedLounges=getLounges(code); refreshed=true; hydrating=false;
      if(cacheNeedsRepair(cachedLounges)) { hydrating=true; refreshAirportInBackground(code); }
    } catch(fastErr){
      refreshError=fastErr.message;
      a=getAirport(code); cachedLounges=getLounges(code);
      if(!a || !cachedLounges.length) {
        // Start robust repair for the next attempt, but return within the 1-minute SLA.
        refreshAirportInBackground(code);
        return res.status(504).json({error:`Chưa lấy xong dữ liệu sân bay ${code} trong giới hạn 1 phút. Hệ thống đang tiếp tục cập nhật nền, vui lòng thử lại sau ít phút.`,detail:fastErr.message});
      }
      hydrating=cacheNeedsRepair(cachedLounges);
      if(hydrating) refreshAirportInBackground(code);
    }
  } else if(autoRefreshOnSearch && req.query.autorefresh==='1' && isStale(a)) {
    // V28: chỉ refresh đầy đủ khi được yêu cầu rõ ràng. Lịch cron vẫn tự cập nhật dữ liệu hằng ngày.
    refreshAirportInBackground(code);
  }
  if(!a) return res.status(404).json({error:`Không tìm thấy dữ liệu sân bay ${code}.`});
  let viPending=cacheNeedsViRepair(cachedLounges);
  if(viPending && req.query.translate!=='0'){
    const budget=Math.max(1000,remaining()-1500);
    try{
      await withTimeout(translateAirportInBackground(code),budget,'Dịch tiếng Việt');
    }catch(e){ refreshError=refreshError||e.message; }
    cachedLounges=getLounges(code);
    viPending=cacheNeedsViRepair(cachedLounges);
  }
  // Never label English as Vietnamese. V37 guarantees that a successful search
  // already contains both language datasets.
  if(viPending){
    return res.status(503).json({
      error:`Chưa hoàn tất bản dịch tiếng Việt cho ${code} trong giới hạn 1 phút. Vui lòng bấm Tra cứu lại; dữ liệu đang được giữ trong cache.`,
      detail:refreshError||'Vietnamese translation incomplete',
      retryable:true
    });
  }
  const terminal=String(req.query.terminal||'all').trim().toLowerCase();
  const scope=String(req.query.scope||'all').trim().toLowerCase();
  const datetime=String(req.query.datetime||'').trim();
  const onlyAvailable=req.query.available!=='0';
  let lounges=(cachedLounges.length?cachedLounges:getLounges(code)).map(hydrateTerminal);
  if(terminal && terminal!=='all') lounges=lounges.filter(l=>terminal==='__unknown__'?!l.terminal:(l.terminal && (l.terminal.toLowerCase()===terminal || l.terminal.toLowerCase().includes(terminal) || terminal.includes(l.terminal.toLowerCase()))));
  if(scope!=='all') lounges=lounges.filter(l=>l.access_scope==='all' || l.access_scope===scope);
  lounges=lounges.map(l=>({...l,availability:evaluateOpeningHours(l.opening_en,datetime)}));
  if(datetime && onlyAvailable) lounges=lounges.filter(l=>l.availability.status!=='closed');
  res.json({airport:{...a,terminals:[...new Set([...(a.terminals||[]),...lounges.map(x=>x.terminal).filter(Boolean)])]},lounges,query:{datetime,terminal:req.query.terminal||'all',scope,onlyAvailable},refreshed,refreshError,cacheMode:(firstLookup||repairIncompleteCache)?'fast-complete':'fast-cache',hydrating,translationPending:false});
});
app.get('/api/sync-status/:airport',(req,res)=>res.json(recentSyncRuns(req.params.airport,10)));
app.post('/api/sync/:airport',async(req,res)=>{
  if(process.env.SYNC_TOKEN && req.get('x-sync-token')!==process.env.SYNC_TOKEN) return res.status(401).json({error:'Unauthorized'});
  try{res.json(await syncAirportWithRetry(req.params.airport,2));}catch(e){console.error(e);res.status(500).json({error:'Chưa thể cập nhật dữ liệu từ LoungeKey.',detail:e.message});}
});

cron.schedule(process.env.CRON_SCHEDULE||'15 3 * * *',async()=>{
  const configured=(process.env.AUTO_SYNC_AIRPORTS||'').split(',').map(x=>x.trim().toUpperCase()).filter(Boolean);
  // Refresh every airport that users have already searched, plus any explicitly configured airports.
  const airports=[...new Set([...listAirportCodes(),...configured])];
  for(const code of airports){try{console.log('sync',code,await syncAirport(code));}catch(e){console.error('sync failed',code,e.message)}}
},{timezone:process.env.TZ||'Asia/Ho_Chi_Minh'});
const port=Number(process.env.PORT||3000); app.listen(port,()=>console.log(`Lounge Finder V37 (VI+EN ready together, <= 1 minute) running at http://localhost:${port}`));
