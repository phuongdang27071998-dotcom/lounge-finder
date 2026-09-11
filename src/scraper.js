import { chromium } from 'playwright';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { upsertAirport, upsertLounge, getLounge, getAirport, updateLoungeTerminal, deleteLoungesNotIn, startSyncRun, finishSyncRun, markAirportSyncFailure } from './db.js';
import { translateVi, translateViBatch, translateManyVi } from './translate.js';

const ROOT = process.env.SOURCE_URL || 'https://loungefinder.loungekey.com/en/linkcarevn/';
const SOURCE_CODE = process.env.SOURCE_CODE || 'LSAPLINKCAREV23';
const AIRPORT_API = new URL('/umbraco/api/consumerloungeapi/airportloungesearch/', ROOT).href;
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const diagnosticsDir = path.resolve(__dirname, '../data/diagnostics');
fs.mkdirSync(diagnosticsDir, { recursive: true });

const clean = (s='') => String(s).replace(/\u00a0/g,' ').replace(/[ \t]+/g,' ').replace(/\n{3,}/g,'\n\n').trim();
const same = (a,b) => clean(a) === clean(b);
const codeFromUrl = (u='') => { try { return new URL(u).searchParams.get('loungecode') || ''; } catch { return ''; } };
async function viValue(previous,enKey,viKey,newEnglish){
  const en=clean(newEnglish);
  if(!en) return '';
  const oldEn=clean(previous?.[enKey]||'');
  const oldVi=clean(previous?.[viKey]||'');
  // Preserve a good existing translation when the English source has not changed.
  if(oldEn===en && oldVi && oldVi.toLowerCase()!==en.toLowerCase()) return oldVi;
  return translateVi(en);
}

async function viFields(previous, fields){
  const keys=['opening','location','conditions','notes','additional'];
  const enKeys={opening:'opening_en',location:'location_en',conditions:'conditions_en',notes:'notes_en',additional:'additional_en'};
  const viKeys={opening:'opening_vi',location:'location_vi',conditions:'conditions_vi',notes:'notes_vi',additional:'additional_vi'};
  const out={}; const need=[]; const needKeys=[];
  for(const key of keys){
    const en=clean(fields[key]||'');
    if(!en){out[key]='';continue;}
    const oldEn=clean(previous?.[enKeys[key]]||'');
    const oldVi=clean(previous?.[viKeys[key]]||'');
    if(oldEn===en && oldVi && oldVi.toLowerCase()!==en.toLowerCase()) out[key]=oldVi;
    else {need.push(en);needKeys.push(key);}
  }
  if(need.length){
    const translated=await translateViBatch(need);
    translated.forEach((v,i)=>{out[needKeys[i]]=v||'';});
  }
  return out;
}
function terminalFromText(s=''){
  const text=clean(s);
  if(!text) return '';
  // Explicit numbered/lettered terminal statements.
  let m=text.match(/\bTerminal\s*(?:No\.?|Number)?\s*[-:]?\s*([0-9]{1,2}|[A-Z])\b/i);
  if(m) return `Terminal ${String(m[1]).toUpperCase()}`;
  m=text.match(/(?:^|[\s,(])T\s*[-:]?\s*([0-9]{1,2})(?=[\s,).:-]|$)/i);
  if(m) return `Terminal ${m[1]}`;
  // LoungeKey often describes a terminal as International/Domestic Departures rather than saying "Terminal".
  if(/\binternational\s+(?:departures?|arrivals?|terminal|area|concourse)\b/i.test(text) || /\binternational terminal\b/i.test(text)) return 'International Terminal';
  if(/\bdomestic\s+(?:departures?|arrivals?|terminal|area|concourse)\b/i.test(text) || /\bdomestic terminal\b/i.test(text)) return 'Domestic Terminal';
  m=text.match(/\b(Main Terminal|South Terminal|North Terminal|West Terminal|East Terminal)\b/i);
  if(m) return m[1].replace(/\b\w/g,c=>c.toUpperCase());
  m=text.match(/\b(South Node|North Node)\b/i);
  if(m) return m[1].replace(/\b\w/g,c=>c.toUpperCase());
  m=text.match(/\bConcourse\s+([A-Z0-9]{1,3})\b/i);
  if(m) return `Concourse ${String(m[1]).toUpperCase()}`;
  return '';
}
function accessScope(...parts){
  const s=parts.join(' ').toLowerCase();
  const domestic=/domestic (?:departures|flights|passengers)|domestic only/.test(s);
  const international=/international (?:departures|flights|passengers)|international only|transit flights|in transit|transit area/.test(s);
  if(domestic&&!international) return 'domestic';
  if(international&&!domestic) return 'international';
  return 'all';
}
async function launch(){ return chromium.launch({headless:true}); }

async function saveDiagnostic(page,code,label,extra=''){
  const stamp=new Date().toISOString().replace(/[:.]/g,'-');
  const base=path.join(diagnosticsDir,`${code}-${stamp}-${label}`);
  await page.screenshot({path:base+'.png',fullPage:true}).catch(()=>{});
  fs.writeFileSync(base+'.html',await page.content().catch(()=>''));
  fs.writeFileSync(base+'.txt',clean(`${extra}\n\n${await page.locator('body').innerText().catch(()=>'')}`));
  return base;
}

async function fetchAirportMatches(searchText){
  const url = new URL(AIRPORT_API);
  url.searchParams.set('sourceCode', SOURCE_CODE);
  url.searchParams.set('searchText', searchText);
  url.searchParams.set('languageCode', 'en');
  const r = await fetch(url, {method:'POST', headers:{'accept':'application/json','referer':ROOT,'user-agent':'Mozilla/5.0'}});
  if(!r.ok) throw new Error(`Airport API ${r.status}`);
  return r.json();
}

export async function searchSourceAirports(query){
  const q=clean(query); if(!q) return [];
  const rows=await fetchAirportMatches(q);
  const out=[];
  for(const country of Array.isArray(rows)?rows:[]){
    for(const a of country.Airports||[]){
      const item={code:a.AirportCode,name_en:a.AirportName,city:a.AirportCity,country:country.Country,country_code:country.CountryCode};
      if(item.code && !out.some(x=>x.code===item.code)) out.push(item);
    }
  }
  return out.slice(0,50);
}

// Collect every lounge link that LoungeKey renders for one airport.
// Verified DOM pattern: #divLoungeDetail .lounge-nav a[href*="loungecode="]
// and mobile/desktop result cards under section.terminal / ul.brand-list.
async function collectAirportLoungeLinks(page,code){
  const links = await page.evaluate((airportCode)=>{
    const out=[];
    const seen=new Set();
    const add=(a)=>{
      const raw=a.getAttribute('href')||'';
      if(!/loungecode=/i.test(raw)) return;
      let u; try{u=new URL(raw,location.href);}catch{return;}
      const ac=(u.searchParams.get('airportcode')||'').toUpperCase();
      const lc=u.searchParams.get('loungecode')||'';
      if(!lc || (ac && ac!==airportCode)) return;
      u.searchParams.set('airportcode',airportCode);
      const href=u.href;
      if(seen.has(href)) return;
      seen.add(href);
      const group=a.closest('[data-terminal-code], section.terminal, .terminal');
      let terminalHint='';
      let terminalCode='';
      const terminalRe=/\b(?:terminal(?:\s*(?:no\.?|number)?\s*[-:]?\s*[0-9A-Z]{1,3})?|international terminal|domestic terminal|main terminal|south terminal|north terminal|west terminal|east terminal|south node|north node|concourse\s+[A-Z0-9]{1,3})\b/i;
      const accept=(txt)=>{
        const t=(txt||'').replace(/\s+/g,' ').trim();
        if(!t || /^airport lounges?$/i.test(t) || t.length>140) return false;
        const m=t.match(terminalRe); if(m){ terminalHint=m[0]; return true; }
        return false;
      };
      if(group){
        terminalCode=group.getAttribute('data-terminal-code')||'';
        const attrHint=group.getAttribute('data-terminal-name')||group.getAttribute('data-terminal-title')||group.getAttribute('aria-label')||group.getAttribute('title')||'';
        accept(attrHint);
        const candidates=[
          group.querySelector('.terminal-title'), group.querySelector('.terminal-name'), group.querySelector('.terminal-label'),
          group.querySelector('h2'), group.querySelector('h3'), group.querySelector('h4'), group.querySelector(':scope > .title'),
          group.previousElementSibling, group.previousElementSibling?.previousElementSibling,
          group.parentElement?.previousElementSibling, group.parentElement?.querySelector(':scope > h2'), group.parentElement?.querySelector(':scope > h3'),
          group.parentElement?.querySelector(':scope > .terminal-title'), group.parentElement?.querySelector(':scope > .title')
        ].filter(Boolean);
        for(const el of candidates){ if(terminalHint) break; accept(el.textContent||''); }
        // LoungeKey desktop sidebar often renders the terminal label in a separate accordion header.
        if(!terminalHint){
          let n=group; let hops=0;
          while(n && hops++<6 && !terminalHint){
            let prev=n.previousElementSibling; let p=0;
            while(prev && p++<5 && !terminalHint){ accept(prev.textContent||''); prev=prev.previousElementSibling; }
            n=n.parentElement;
          }
        }
      }
      // Visual fallback: nearest terminal-labelled heading/button above the lounge link.
      if(!terminalHint){
        const ar=a.getBoundingClientRect();
        let best=null, bestDist=1e9;
        document.querySelectorAll('h1,h2,h3,h4,h5,h6,button,.terminal-title,.terminal-name,.terminal-label,.panel-title,.accordion-toggle,.title').forEach(el=>{
          const txt=(el.textContent||'').replace(/\s+/g,' ').trim();
          if(!terminalRe.test(txt)) return;
          const r=el.getBoundingClientRect();
          if(r.bottom<=ar.top+8){ const d=ar.top-r.bottom; if(d<bestDist){bestDist=d;best=txt;} }
        });
        if(best) accept(best);
      }
      out.push({href,text:(a.textContent||'').replace(/\s+/g,' ').trim(),loungeCode:lc,terminalHint,terminalCode});
    };
    document.querySelectorAll('#divLoungeDetail .lounge-nav a[href*="loungecode="], section.terminal a[href*="loungecode="], ul.brand-list a[href*="loungecode="], a[href*="loungecode="]').forEach(add);
    return out;
  },code).catch(()=>[]);
  return links;
}

async function waitAirportPage(page,code){
  await page.waitForLoadState('domcontentloaded').catch(()=>{});
  await page.waitForSelector(`a[href*="airportcode=${code}"][href*="loungecode="]`,{timeout:15000}).catch(()=>{});
  await page.waitForTimeout(500);
}

async function airportNameFromPage(page,code){
  const text=clean(await page.locator('body').innerText().catch(()=>''));
  const m=text.match(new RegExp(`([^\\n]{3,140})\\s*\\(${code}\\)`,'i'));
  if(m) return clean(m[1]);
  try{
    const rows=await fetchAirportMatches(code);
    for(const c of rows||[]) for(const a of c.Airports||[]) if(a.AirportCode===code) return a.AirportName;
  }catch{}
  return code;
}

async function extractDetail(page){
  await page.waitForLoadState('domcontentloaded').catch(()=>{});
  await page.waitForSelector('#details',{timeout:15000}).catch(()=>{});
  await page.waitForTimeout(350);
  return page.evaluate(()=>{
    const clean=s=>(s||'').replace(/\u00a0/g,' ').replace(/[ \t]+/g,' ').replace(/\n{3,}/g,'\n\n').trim();
    const details=document.querySelector('#details');
    const sections={};
    if(details){
      const heads=[...details.querySelectorAll(':scope > h1,:scope > h2,:scope > h3,:scope > h4,:scope > h5,:scope > h6')];
      for(const h of heads){
        const title=clean(h.textContent).replace(/[:：]\s*$/,'');
        const vals=[]; let n=h.nextElementSibling;
        while(n && !/^H[1-6]$/.test(n.tagName)){
          const t=clean(n.innerText||n.textContent||''); if(t) vals.push(t); n=n.nextElementSibling;
        }
        if(title) sections[title]=clean(vals.join('\n'));
      }
    }
    const imageUrls=[];
    document.querySelectorAll('#lounge-carousel .carousel-inner img').forEach(img=>{
      const src=img.getAttribute('src')||img.getAttribute('data-src')||img.getAttribute('data-lazy-src')||'';
      if(!src) return;
      try{const u=new URL(src,location.href).href;if(!imageUrls.includes(u)) imageUrls.push(u);}catch{}
    });
    const titleSelectors=['.lounge-info h1','.lounge-info h2','.lounge-info h3','.lounge-info h4','.lounge-detail h1','.lounge-detail h2','.lounge-detail h3','.lounge-detail h4'];
    let name='';
    for(const s of titleSelectors){const el=document.querySelector(s);const t=clean(el?.textContent||'');if(t&&!/opening hours|location|conditions/i.test(t)){name=t;break;}}
    if(!name){
      const code=new URL(location.href).searchParams.get('loungecode')||'';
      const active=[...document.querySelectorAll(`a[href*="loungecode=${CSS.escape(code)}"]`)].find(a=>clean(a.textContent));
      name=clean(active?.textContent||'');
    }
    return {sections,fullDetail:clean(details?.innerText||''),imageUrls,name};
  }).catch(()=>({sections:{},fullDetail:'',imageUrls:[],name:''}));
}

function sectionValue(sections,labels){
  for(const [k,v] of Object.entries(sections||{})){
    const n=k.toLowerCase().replace(/[:：]\s*$/,'').trim();
    if(labels.some(x=>n===x||n.startsWith(x))) return clean(v);
  }
  return '';
}

async function translateSourceSections(sections,known={}){
  const out={};
  const headingMap={
    'opening hours':'Giờ hoạt động','hours of operation':'Giờ hoạt động','location':'Vị trí',
    'conditions':'Điều kiện sử dụng','conditions of use':'Điều kiện sử dụng','conditions of access':'Điều kiện sử dụng',
    'important information':'Thông tin quan trọng','important info':'Thông tin quan trọng',
    'additional information':'Thông tin bổ sung','additional info':'Thông tin bổ sung'
  };
  for(const [title,value] of Object.entries(sections||{})){
    const key=title.toLowerCase().replace(/[:：]\s*$/,'').trim();
    const titleVi=headingMap[key] || await translateVi(title);
    let valueVi='';
    if(key.startsWith('opening')) valueVi=known.opening||'';
    else if(key==='location'||key.startsWith('where')) valueVi=known.location||'';
    else if(key.startsWith('conditions')||key.startsWith('access conditions')) valueVi=known.conditions||'';
    else if(key.startsWith('important')||key.startsWith('please note')) valueVi=known.notes||'';
    else if(key.startsWith('additional')||key.startsWith('other information')||key.startsWith('more information')) valueVi=known.additional||'';
    if(!valueVi) valueVi=await translateVi(value);
    out[title]={title_vi:titleVi,value_vi:valueVi};
  }
  return out;
}

export async function discoverAirportIndex(airportCode){
  const code=clean(airportCode).toUpperCase();
  if(!/^[A-Z]{3}$/.test(code)) throw new Error('Mã sân bay phải là mã IATA gồm 3 ký tự.');

  // V28 fast path: the LoungeKey airport page is server-rendered, so terminal names
  // and lounge links can be read with one lightweight HTTP request instead of launching Chromium.
  const airportUrl=new URL('lounge-detail/',ROOT); airportUrl.searchParams.set('airportcode',code);
  const r=await fetch(airportUrl.href,{headers:{'accept':'text/html,application/xhtml+xml','user-agent':'Mozilla/5.0'}});
  if(!r.ok) throw new Error(`LoungeKey ${r.status}`);
  const html=await r.text();
  const decode=(x='')=>String(x)
    .replace(/&amp;/g,'&').replace(/&quot;/g,'"').replace(/&#39;/g,"'")
    .replace(/&lt;/g,'<').replace(/&gt;/g,'>').replace(/&nbsp;/g,' ')
    .replace(/<[^>]+>/g,' ').replace(/\s+/g,' ').trim();
  const links=[]; const seen=new Set(); const terminals=new Set();
  const addLinks=(chunk,terminal='')=>{
    const re=/<a\b[^>]*href=["']([^"']*loungecode=[^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi;
    let m;
    while((m=re.exec(chunk))){
      let u; try{u=new URL(m[1],airportUrl.href);}catch{continue;}
      const lc=u.searchParams.get('loungecode')||'';
      const ac=(u.searchParams.get('airportcode')||code).toUpperCase();
      if(!lc||ac!==code||seen.has(lc)) continue;
      seen.add(lc); u.searchParams.set('airportcode',code);
      const anchorHtml=m[2]||'';
      const titleMatch=anchorHtml.match(/<h[1-6]\b[^>]*>([\s\S]*?)<\/h[1-6]>/i);
      const name=decode(titleMatch?titleMatch[1]:anchorHtml)||`Lounge ${lc}`;
      const imgMatch=anchorHtml.match(/<img\b[^>]*src=["']([^"']+)["']/i);
      let image='';
      if(imgMatch){ try{image=new URL(imgMatch[1],airportUrl.href).href;}catch{} }
      const t=terminalFromText(terminal||name);
      if(t) terminals.add(t);
      links.push({loungeCode:lc,name,terminal:t,href:u.href,image});
      const previous=getLounge(code,lc);
      // IMPORTANT: terminal discovery must never create empty lounge rows.
      // Empty rows made /api/search think the airport was already cached and caused cards with '--'.
      if(previous && t) updateLoungeTerminal(code,lc,t);
    }
  };

  // Main content: <section class="terminal"> ... <h3>Terminal 1</h3> ... lounge links
  const sectionStarts=[...html.matchAll(/<section\b[^>]*class=["'][^"']*\bterminal\b[^"']*["'][^>]*>/gi)];
  for(let i=0;i<sectionStarts.length;i++){
    const a=sectionStarts[i].index||0;
    const b=i+1<sectionStarts.length?(sectionStarts[i+1].index||html.length):html.length;
    const chunk=html.slice(a,b);
    const hm=chunk.match(/<h[1-6]\b[^>]*>([\s\S]*?)<\/h[1-6]>/i);
    const terminal=hm?terminalFromText(decode(hm[1])):'';
    addLinks(chunk,terminal);
  }

  // Sidebar fallback: terminal label immediately before its .terminal block.
  if(!links.length){
    const blockRe=/<a\b[^>]*class=["'][^"']*\bsample\b[^"']*["'][^>]*>([\s\S]*?)<\/a>\s*<div\b[^>]*class=["'][^"']*\bterminal\b[^"']*["'][^>]*>([\s\S]*?)(?=<a\b[^>]*class=["'][^"']*\bsample\b|<\/nav>|<\/div>\s*<\/nav>)/gi;
    let bm;
    while((bm=blockRe.exec(html))) addLinks(bm[2],terminalFromText(decode(bm[1])));
  }
  if(!links.length) addLinks(html,'');
  if(!links.length) throw new Error(`Không đọc được danh sách phòng chờ của ${code}.`);

  let airportName=code;
  const nameRe=new RegExp(`<p[^>]*>([^<]{2,160})\\s*\\(${code}\\)<\\/p>`,'i');
  const nm=html.match(nameRe);
  if(nm) airportName=decode(nm[1]);
  else {
    try{
      const rows=await fetchAirportMatches(code);
      for(const c of rows||[]) for(const a of c.Airports||[]) if(a.AirportCode===code){airportName=a.AirportName;break;}
    }catch{}
  }
  const prev=getAirport(code);
  const termList=[...terminals].sort((a,b)=>a.localeCompare(b,undefined,{numeric:true}));
  upsertAirport({code,name_en:airportName,name_vi:prev?.name_vi||airportName,terminals:termList,updated_at:prev?.updated_at||new Date().toISOString(),last_success_at:prev?.last_success_at||'',source_status:prev?.source_status||'cache',last_error:prev?.last_error||''});
  return {code,airportName,terminals:termList,links};
}



function decodeHtmlText(x='') {
  return clean(String(x)
    .replace(/&amp;/g,'&').replace(/&quot;/g,'"').replace(/&#39;|&#x27;/gi,"'")
    .replace(/&lt;/g,'<').replace(/&gt;/g,'>').replace(/&nbsp;|&#160;/gi,' ')
    .replace(/<br\s*\/?\s*>/gi,'\n').replace(/<\/p>/gi,'\n')
    .replace(/<[^>]+>/g,' ')
    .replace(/&#(\d+);/g,(_,n)=>String.fromCharCode(Number(n)))
    .replace(/\s*\n\s*/g,'\n'));
}

function parseDetailHtmlFast(html,url='') {
  const root=String(html||'');
  const detailsMatch=root.match(/<div\b[^>]*id=["']details["'][^>]*>([\s\S]*?)(?=<\/div>\s*<\/div>|<div\b[^>]*class=["'][^"']*tab-pane|<footer\b|$)/i);
  const details=detailsMatch?detailsMatch[1]:root;
  const sections={};
  const headingRe=/<h([1-6])\b[^>]*>([\s\S]*?)<\/h\1>/gi;
  const heads=[...details.matchAll(headingRe)];
  for(let i=0;i<heads.length;i++){
    const title=decodeHtmlText(heads[i][2]);
    if(!title) continue;
    const start=(heads[i].index||0)+heads[i][0].length;
    const end=i+1<heads.length?(heads[i+1].index||details.length):details.length;
    const value=decodeHtmlText(details.slice(start,end));
    if(value) sections[title]=value;
  }
  // Some pages use bold labels rather than headings.
  if(!Object.keys(sections).length){
    const labelRe=/<(?:strong|b)\b[^>]*>(Opening Hours|Location|Conditions|Important Information|Additional Information|Additional Info|Please Note)\s*:?[\s\S]*?<\/(?:strong|b)>/gi;
    const labs=[...details.matchAll(labelRe)];
    for(let i=0;i<labs.length;i++){
      const title=decodeHtmlText(labs[i][1]);
      const start=(labs[i].index||0)+labs[i][0].length;
      const end=i+1<labs.length?(labs[i+1].index||details.length):details.length;
      const value=decodeHtmlText(details.slice(start,end));
      if(value) sections[title]=value;
    }
  }
  const nameMatch=root.match(/<div\b[^>]*class=["'][^"']*lounge-detail[^"']*["'][^>]*>[\s\S]*?<h2\b[^>]*>([\s\S]*?)<\/h2>/i) || root.match(/<h2\b[^>]*class=["'][^"']*colorBlack[^"']*["'][^>]*>([\s\S]*?)<\/h2>/i);
  const name=decodeHtmlText(nameMatch?nameMatch[1]:'');
  const terminalHeader=(root.match(/<h4\b[^>]*class=["'][^"']*colorBlack[^"']*["'][^>]*>([\s\S]*?)<\/h4>/i)||[])[1]||'';
  const images=[];
  const carousel=(root.match(/<div\b[^>]*id=["']lounge-carousel["'][^>]*>([\s\S]*?)(?=<div\b[^>]*class=["'][^"']*lounge-info|<div\b[^>]*class=["'][^"']*tab-content)/i)||[])[1]||root;
  for(const m of carousel.matchAll(/<img\b[^>]*src=["']([^"']+)["']/gi)){
    try{const u=new URL(m[1],url).href;if(!/logo|linkcare|icon|sprite|flag|placeholder|brand/i.test(u)&&!images.includes(u))images.push(u);}catch{}
  }
  const fullDetail=decodeHtmlText(details);
  return {name,terminalHeader:decodeHtmlText(terminalHeader),sections,imageUrls:images,fullDetail};
}

export async function fastSyncAirport(airportCode,{translate=true}={}){
  const code=clean(airportCode).toUpperCase();
  if(!/^[A-Z]{3}$/.test(code)) throw new Error('Mã sân bay phải là mã IATA gồm 3 ký tự.');
  const runId=startSyncRun(code); let count=0;
  try{
    const index=await discoverAirportIndex(code);
    const links=index.links||[];
    if(!links.length) throw new Error(`Không đọc được danh sách phòng chờ của ${code}.`);
    const terminals=new Set(index.terminals||[]); const currentCodes=[]; const lounges=[];
    let cursor=0;
    const concurrency=Math.max(2,Math.min(10,Number(process.env.FAST_SYNC_CONCURRENCY||8)));
    async function worker(){
      while(true){
        const idx=cursor++; if(idx>=links.length) return;
        const link=links[idx]; const loungeCode=link.loungeCode;
        const previous=getLounge(code,loungeCode); currentCodes.push(loungeCode);
        try{
          const r=await fetch(link.href,{headers:{'accept':'text/html,application/xhtml+xml','user-agent':'Mozilla/5.0'}});
          if(!r.ok) throw new Error(`LoungeKey detail ${r.status}`);
          const html=await r.text();
          const extracted=parseDetailHtmlFast(html,link.href); const sections=extracted.sections||{};
          const name=clean(extracted.name||link.name||previous?.name_en)||`Lounge ${loungeCode}`;
          const opening=sectionValue(sections,['opening hours','hours of operation','opening time','opening times','hours'])||previous?.opening_en||'';
          const location=sectionValue(sections,['location','where is the lounge','where to find us'])||previous?.location_en||'';
          const conditions=sectionValue(sections,['conditions','conditions of use','conditions of entry','access conditions','terms and conditions','conditions of access'])||previous?.conditions_en||'';
          const notes=sectionValue(sections,['important information','important info','please note','important notes','notice'])||previous?.notes_en||'';
          const additional=sectionValue(sections,['additional information','additional info','other information','more information'])||previous?.additional_en||'';
          const scope=accessScope(location,conditions,notes,additional,extracted.fullDetail||'');
          const terminal=terminalFromText(`${extracted.terminalHeader||''} ${link.terminal||''} ${name} ${location}`)||(scope==='international'?'International Terminal':scope==='domestic'?'Domestic Terminal':'');
          if(terminal) terminals.add(terminal);
          let openingVi=previous?.opening_vi||'', locationVi=previous?.location_vi||'', conditionsVi=previous?.conditions_vi||'', notesVi=previous?.notes_vi||'', additionalVi=previous?.additional_vi||'';
          let sourceSectionsVi=previous?.source_sections_vi||{};
          if(translate){
            const vi=await viFields(previous,{opening,location,conditions,notes,additional});
            ({opening:openingVi,location:locationVi,conditions:conditionsVi,notes:notesVi,additional:additionalVi}=vi);
            sourceSectionsVi=await translateSourceSections(sections,{opening:openingVi,location:locationVi,conditions:conditionsVi,notes:notesVi,additional:additionalVi});
          }
          const imageSet=(extracted.imageUrls||[]).length?extracted.imageUrls:(previous?.image_urls||[]);
          const item={
            airport_code:code,lounge_code:loungeCode,name_en:name,name_vi:(previous&&same(previous.name_en,name)&&previous.name_vi)||name,
            terminal,access_scope:scope,opening_en:opening,opening_vi:openingVi,location_en:location,location_vi:locationVi,conditions_en:conditions,conditions_vi:conditionsVi,
            facilities_en:'',facilities_vi:'',notes_en:notes,notes_vi:notesVi,additional_en:additional,additional_vi:additionalVi,
            source_sections:Object.keys(sections).length?sections:(previous?.source_sections||{}),source_sections_vi:sourceSectionsVi,
            full_detail_en:extracted.fullDetail||previous?.full_detail_en||'',full_detail_vi:previous?.full_detail_vi||'',source_url:link.href,
            image_url:imageSet[0]||link.image||previous?.image_url||'',image_urls:imageSet.length?imageSet:(link.image?[link.image]:[]),updated_at:new Date().toISOString()
          };
          upsertLounge(item); lounges.push(item);
        }catch(e){
          if(previous && (previous.opening_en||previous.location_en||previous.conditions_en)){lounges.push(previous);}
        }
      }
    }
    await Promise.all(Array.from({length:Math.min(concurrency,links.length)},()=>worker()));
    if(!lounges.length) throw new Error(`Không lấy được chi tiết phòng chờ cho ${code}.`);
    deleteLoungesNotIn(code,currentCodes);
    const syncedAt=new Date().toISOString();
    const airportName=index.airportName||getAirport(code)?.name_en||code;
    upsertAirport({code,name_en:airportName,name_vi:getAirport(code)?.name_vi||airportName,terminals:[...terminals].sort((a,b)=>a.localeCompare(b,undefined,{numeric:true})),updated_at:syncedAt,last_success_at:syncedAt,source_status:'ok',last_error:''});
    count=lounges.length; finishSyncRun(runId,{status:'success',count});
    return {code,airportName,count,terminals:[...terminals],syncedAt,loungeCodes:currentCodes,mode:'fast-http'};
  }catch(e){finishSyncRun(runId,{status:'failed',count,error:e.message});markAirportSyncFailure(code,e.message);throw e;}
}


export async function translateCachedAirport(airportCode){
  const code=clean(airportCode).toUpperCase();
  const { getLounges } = await import('./db.js');
  const rows=getLounges(code)||[];
  if(!rows.length) return {code,count:0,translated:0};

  const headingMap={
    'opening hours':'Giờ hoạt động','hours of operation':'Giờ hoạt động','location':'Vị trí',
    'conditions':'Điều kiện sử dụng','conditions of use':'Điều kiện sử dụng','conditions of access':'Điều kiện sử dụng',
    'important information':'Thông tin quan trọng','important info':'Thông tin quan trọng','please note':'Lưu ý',
    'additional information':'Thông tin bổ sung','additional info':'Thông tin bổ sung','other information':'Thông tin bổ sung','more information':'Thông tin bổ sung'
  };
  const sectionCoreKey=(title='')=>{
    const k=String(title).toLowerCase().replace(/[:：]\s*$/,'').trim();
    if(k.startsWith('opening')||k==='hours of operation') return 'opening';
    if(k==='location'||k.startsWith('where')) return 'location';
    if(k.startsWith('conditions')||k.startsWith('access conditions')) return 'conditions';
    if(k.startsWith('important')||k.startsWith('please note')) return 'notes';
    if(k.startsWith('additional')||k.startsWith('other information')||k.startsWith('more information')) return 'additional';
    return '';
  };
  const enKey={opening:'opening_en',location:'location_en',conditions:'conditions_en',notes:'notes_en',additional:'additional_en'};
  const viKey={opening:'opening_vi',location:'location_vi',conditions:'conditions_vi',notes:'notes_vi',additional:'additional_vi'};
  const values=[]; const indexByText=new Map();
  const addText=(text='')=>{
    const t=clean(text); if(!t) return -1;
    if(indexByText.has(t)) return indexByText.get(t);
    const i=values.length; values.push(t); indexByText.set(t,i); return i;
  };

  const plans=rows.map(l=>{
    const core={};
    for(const k of Object.keys(enKey)){
      const en=clean(l[enKey[k]]||''); const vi=clean(l[viKey[k]]||'');
      core[k]={en, existing:vi, idx:(en && (!vi || (en.length>30 && en.toLowerCase()===vi.toLowerCase())))?addText(en):-1};
    }
    const sections=l.source_sections&&typeof l.source_sections==='object'?l.source_sections:{};
    const oldVi=l.source_sections_vi&&typeof l.source_sections_vi==='object'?l.source_sections_vi:{};
    const sectionPlans=[];
    for(const [title,value] of Object.entries(sections)){
      const k=String(title).toLowerCase().replace(/[:：]\s*$/,'').trim();
      const coreKey=sectionCoreKey(title);
      const old=oldVi[title]||{};
      const titleExisting=clean(old.title_vi||'');
      const valueExisting=clean(old.value_vi||'');
      const titleIdx=headingMap[k]||titleExisting ? -1 : addText(title);
      const valueIdx=coreKey ? -1 : ((!valueExisting || (String(value).length>30 && clean(value).toLowerCase()===valueExisting.toLowerCase())) ? addText(value) : -1);
      sectionPlans.push({title,value,k,coreKey,old,titleIdx,valueIdx});
    }
    return {l,core,sectionPlans};
  });

  // One airport-wide translation wave instead of translating lounge-by-lounge.
  // In normal use this is just a few concurrent HTTP requests and finishes in seconds.
  const translated=await translateManyVi(values,{batchChars:3200,batchItems:12});
  const textAt=idx=>idx>=0?clean(translated[idx]||''):'';
  let count=0;
  for(const plan of plans){
    const {l,core,sectionPlans}=plan;
    const vi={};
    for(const k of Object.keys(core)) vi[k]=textAt(core[k].idx)||core[k].existing||'';
    const sourceSectionsVi={};
    for(const sp of sectionPlans){
      const titleVi=headingMap[sp.k]||sp.old.title_vi||textAt(sp.titleIdx)||sp.title;
      let valueVi='';
      if(sp.coreKey) valueVi=vi[sp.coreKey]||sp.old.value_vi||'';
      else valueVi=textAt(sp.valueIdx)||sp.old.value_vi||'';
      sourceSectionsVi[sp.title]={title_vi:titleVi,value_vi:valueVi};
    }
    upsertLounge({...l,
      opening_vi:vi.opening||'', location_vi:vi.location||'', conditions_vi:vi.conditions||'',
      notes_vi:vi.notes||'', additional_vi:vi.additional||'', source_sections_vi:sourceSectionsVi,
      updated_at:l.updated_at||new Date().toISOString()
    });
    count++;
  }
  return {code,count:rows.length,translated:count};
}

export async function syncAirport(airportCode){
  const code=clean(airportCode).toUpperCase();
  if(!/^[A-Z]{3}$/.test(code)) throw new Error('Mã sân bay phải là mã IATA gồm 3 ký tự, ví dụ DOH.');
  const runId=startSyncRun(code); let count=0;
  const browser=await launch();
  const page=await browser.newPage({viewport:{width:1440,height:1000}});
  try{
    // Direct route is much more reliable than automating the autocomplete UI.
    const airportUrl=new URL('lounge-detail/',ROOT);
    airportUrl.searchParams.set('airportcode',code);
    await page.goto(airportUrl.href,{waitUntil:'domcontentloaded',timeout:60000});
    await waitAirportPage(page,code);

    let links=await collectAirportLoungeLinks(page,code);
    // De-duplicate by lounge code, because the same lounge is rendered in desktop + mobile markup.
    const byCode=new Map();
    for(const x of links){ if(x.loungeCode && !byCode.has(x.loungeCode)) byCode.set(x.loungeCode,x); }
    links=[...byCode.values()];
    if(!links.length){
      const diag=await saveDiagnostic(page,code,'no-lounge-links',`URL: ${page.url()}`);
      throw new Error(`Không đọc được danh sách phòng chờ từ LoungeKey. File chẩn đoán: ${diag}`);
    }

    const airportName=await airportNameFromPage(page,code);
    const terminals=new Set(); const currentCodes=[]; const lounges=[];
    const previousByCode=new Map(links.map(link=>[link.loungeCode,getLounge(code,link.loungeCode)]));
    const concurrency=Math.max(1,Math.min(6,Number(process.env.SYNC_CONCURRENCY||4)));
    let cursor=0;
    async function worker(){
      while(true){
        const idx=cursor++; if(idx>=links.length) return;
        const link=links[idx];
        const detail=await browser.newPage({viewport:{width:1280,height:1200}});
        try{
          await detail.goto(link.href,{waitUntil:'domcontentloaded',timeout:60000});
          const extracted=await extractDetail(detail);
          const sections=extracted.sections||{};
          let name=clean(extracted.name||link.text)||`Lounge ${link.loungeCode}`;
          const opening=sectionValue(sections,['opening hours','hours of operation','opening time','opening times','hours']);
          const location=sectionValue(sections,['location','where is the lounge','where to find us']);
          const conditions=sectionValue(sections,['conditions','conditions of use','conditions of entry','access conditions','terms and conditions','conditions of access']);
          const notes=sectionValue(sections,['important information','important info','please note','important notes','notice']);
          const additional=sectionValue(sections,['additional information','other information','more information']);
          const scope=accessScope(location,conditions,notes,additional,extracted.fullDetail||'');
          // Prefer exact source text. If LoungeKey only says international/domestic access, use that as a useful terminal class.
          const terminal=terminalFromText(`${name} ${location} ${conditions} ${link.terminalHint||''}`) || (scope==='international'?'International Terminal':scope==='domestic'?'Domestic Terminal':'');
          if(terminal) terminals.add(terminal);
          const loungeCode=link.loungeCode||codeFromUrl(link.href); currentCodes.push(loungeCode);
          const previous=previousByCode.get(link.loungeCode);
          const imageSet=(extracted.imageUrls||[]).filter(u=>!/logo|linkcare|icon|sprite|flag|placeholder|brand/i.test(u));
          const fullDetail=extracted.fullDetail||previous?.full_detail_en||'';
          const openingEn=opening||previous?.opening_en||'';
          const locationEn=location||previous?.location_en||'';
          const conditionsEn=conditions||previous?.conditions_en||'';
          const notesEn=notes||previous?.notes_en||'';
          const additionalEn=additional||previous?.additional_en||'';
          const vi=await viFields(previous,{opening:openingEn,location:locationEn,conditions:conditionsEn,notes:notesEn,additional:additionalEn});
          const {opening:openingVi,location:locationVi,conditions:conditionsVi,notes:notesVi,additional:additionalVi}=vi;
          const sourceSectionsVi=await translateSourceSections(sections,{opening:openingVi,location:locationVi,conditions:conditionsVi,notes:notesVi,additional:additionalVi});
          const item={
            airport_code:code,lounge_code:loungeCode,name_en:name,name_vi:(previous&&same(previous.name_en,name)&&previous.name_vi)||name,
            terminal,access_scope:scope,
            opening_en:openingEn,opening_vi:openingVi,
            location_en:locationEn,location_vi:locationVi,
            conditions_en:conditionsEn,conditions_vi:conditionsVi,
            facilities_en:'',facilities_vi:'',
            notes_en:notesEn,notes_vi:notesVi,
            additional_en:additionalEn,additional_vi:additionalVi,
            source_sections:sections,source_sections_vi:sourceSectionsVi,
            full_detail_en:fullDetail,full_detail_vi:previous?.full_detail_vi||'',
            source_url:link.href,
            image_url:imageSet[0]||previous?.image_url||'',
            image_urls:imageSet.length?imageSet:(()=>{try{const a=JSON.parse(previous?.image_urls_json||'[]');return Array.isArray(a)?a:[]}catch{return []}})(),
            updated_at:new Date().toISOString()
          };
          if(!opening&&!location&&!conditions) await saveDiagnostic(detail,code,`thin-detail-${loungeCode}`);
          upsertLounge(item); lounges.push(item);
        }catch(e){
          await saveDiagnostic(detail,code,`detail-error-${link.loungeCode}`,e.message).catch(()=>{});
          const previous=previousByCode.get(link.loungeCode);
          if(previous) lounges.push(previous);
        }finally{ await detail.close(); }
      }
    }
    await Promise.all(Array.from({length:Math.min(concurrency,links.length)},()=>worker()));
    if(!lounges.length) throw new Error(`Không lấy được chi tiết phòng chờ cho ${code}.`);
    deleteLoungesNotIn(code,currentCodes);
    const syncedAt=new Date().toISOString();
    upsertAirport({code,name_en:airportName,name_vi:airportName,terminals:[...terminals].sort(),updated_at:syncedAt,last_success_at:syncedAt,source_status:'ok',last_error:''});
    count=lounges.length; finishSyncRun(runId,{status:'success',count});
    return {code,airportName,count,terminals:[...terminals].sort(),syncedAt,loungeCodes:currentCodes};
  }catch(e){
    await saveDiagnostic(page,code,'sync-error',e.message).catch(()=>{});
    finishSyncRun(runId,{status:'failed',count,error:e.message}); markAirportSyncFailure(code,e.message); throw e;
  }finally{ await browser.close(); }
}
