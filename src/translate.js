const cache = new Map();

function cleanup(text='') {
  return String(text).replace(/\u00a0/g,' ').replace(/[ \t]+/g,' ').replace(/\n{3,}/g,'\n\n').trim();
}
function sleep(ms){ return new Promise(r=>setTimeout(r,ms)); }

// Translation is intentionally conservative. Lounge detail pages can contain many
// sections; firing dozens of Google requests in parallel is the main reason V32
// sometimes saved English text into *_vi fields. One request at a time is much
// more reliable and batch translation keeps the total request count low.
const MAX_TRANSLATE_CONCURRENCY = Math.max(1, Math.min(4, Number(process.env.TRANSLATE_CONCURRENCY || 3)));
let active = 0;
const waiters = [];
async function withSlot(fn){
  if(active >= MAX_TRANSLATE_CONCURRENCY) await new Promise(resolve=>waiters.push(resolve));
  active++;
  try { return await fn(); }
  finally { active--; const next=waiters.shift(); if(next) next(); }
}

export function roughVi(text='') {
  const s = cleanup(text);
  if (!s) return '';
  const exact = [
    [/^24 hours daily\.?$/i, '24 giờ mỗi ngày.'],
    [/^Opening Hours$/i, 'Giờ hoạt động'],
    [/^Location$/i, 'Vị trí'],
    [/^Conditions$/i, 'Điều kiện sử dụng'],
    [/^Conditions of Use$/i, 'Điều kiện sử dụng'],
    [/^Conditions of Access$/i, 'Điều kiện sử dụng'],
    [/^Important Information$/i, 'Thông tin quan trọng'],
    [/^Important Info$/i, 'Thông tin quan trọng'],
    [/^Additional Information$/i, 'Thông tin bổ sung'],
    [/^Additional Info$/i, 'Thông tin bổ sung'],
    [/^Please Note$/i, 'Lưu ý']
  ];
  for (const [re, vi] of exact) if (re.test(s)) return vi;
  return s;
}

function parseGoogle(data){
  return cleanup(Array.isArray(data?.[0]) ? data[0].map(x=>x?.[0]||'').join('') : '');
}

async function googleTranslateRequest(text, host, method='POST') {
  const url = new URL('/translate_a/single', host);
  url.searchParams.set('client','gtx');
  url.searchParams.set('sl','en');
  url.searchParams.set('tl','vi');
  url.searchParams.set('dt','t');
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 4500);
  try {
    let r;
    if(method==='GET'){
      url.searchParams.set('q',text);
      r=await fetch(url,{headers:{'accept':'application/json,text/plain,*/*','user-agent':'Mozilla/5.0'},signal:controller.signal});
    }else{
      r=await fetch(url,{
        method:'POST',
        headers:{'content-type':'application/x-www-form-urlencoded;charset=UTF-8','accept':'application/json,text/plain,*/*','user-agent':'Mozilla/5.0'},
        body:new URLSearchParams({q:text}).toString(), signal:controller.signal
      });
    }
    if(!r.ok) throw new Error(`Translate HTTP ${r.status}`);
    return parseGoogle(await r.json());
  } finally { clearTimeout(timer); }
}

function likelyFailedTranslation(source, translated){
  const s=cleanup(source), t=cleanup(translated);
  if(!t) return true;
  if(s.length>24 && s.toLowerCase()===t.toLowerCase()) return true;
  return false;
}

async function googleTranslate(text){
  return withSlot(async()=>{
    const routes=[
      ['https://translate.googleapis.com','POST'],
      ['https://translate.googleapis.com','GET'],
      ['https://translate.google.com','POST'],
      ['https://translate.google.com','GET']
    ];
    let last;
    for(let attempt=0; attempt<2; attempt++){
      const [host,method]=routes[attempt%routes.length];
      try{
        const out=await googleTranslateRequest(text,host,method);
        if(out && !likelyFailedTranslation(text,out)) return out;
        // Very short proper nouns can legitimately be unchanged. Let the caller decide.
        if(out && text.length<=24) return out;
      }catch(e){ last=e; }
      if(attempt<1) await sleep(250);
    }
    if(last) throw last;
    return '';
  });
}

function splitSemantic(text, maxLen=700){
  const src=cleanup(text);
  if(!src) return [];
  if(src.length<=maxLen) return [src];
  const parts=src.split(/(\n+|\s+-\s+|(?<=[.!?;:])\s+)/).filter(Boolean);
  const out=[]; let buf='';
  for(const part of parts){
    if((buf+part).length>maxLen && buf.trim()){out.push(buf.trim());buf='';}
    if(part.length>maxLen){
      for(let i=0;i<part.length;i+=maxLen){if(buf.trim()){out.push(buf.trim());buf='';}out.push(part.slice(i,i+maxLen).trim());}
    }else buf+=part;
  }
  if(buf.trim()) out.push(buf.trim());
  return out.filter(Boolean);
}

async function translateSingleNoCache(source){
  const chunks=splitSemantic(source);
  const out=[];
  for(const chunk of chunks){
    let t='';
    try{ t=await googleTranslate(chunk); }catch{}
    if(!t || likelyFailedTranslation(chunk,t)) return '';
    out.push(t);
  }
  return cleanup(out.join('\n'));
}

export async function translateVi(text='') {
  const source=cleanup(text);
  if(!source) return '';
  if(cache.has(source)) return cache.get(source);
  const out=await translateSingleNoCache(source);
  if(out){ cache.set(source,out); return out; }
  // IMPORTANT: do not cache a failed English fallback. That was the V32 bug:
  // once one request failed, the same English value stayed in memory and every
  // repair attempt reused it instead of trying Google again.
  const fallback=roughVi(source);
  return fallback.toLowerCase()===source.toLowerCase() ? '' : fallback;
}

// Translate several lounge fields in one Google request. This reduces 5-10
// translation calls per lounge down to a single call and avoids rate-limiting.
export async function translateViBatch(values=[]){
  const src=values.map(v=>cleanup(v));
  const result=new Array(src.length).fill('');
  const missing=[];
  src.forEach((s,i)=>{if(!s)return;if(cache.has(s))result[i]=cache.get(s);else missing.push(i);});
  if(!missing.length) return result;

  // Use stable ASCII markers; Google normally preserves these verbatim.
  const marker=i=>`__LFSEP_${i}__`;
  const joined=missing.map((idx,j)=>`${marker(j)}\n${src[idx]}`).join('\n');
  let translated='';
  try{ translated=await googleTranslate(joined); }catch{}
  if(translated){
    const re=/__LFSEP_(\d+)__/g;
    const matches=[...translated.matchAll(re)];
    if(matches.length===missing.length){
      for(let m=0;m<matches.length;m++){
        const start=matches[m].index+matches[m][0].length;
        const end=m+1<matches.length?matches[m+1].index:translated.length;
        const t=cleanup(translated.slice(start,end));
        const idx=missing[m];
        if(t && !likelyFailedTranslation(src[idx],t)){result[idx]=t;cache.set(src[idx],t);}
      }
    }
  }
  // If batch markers were altered, retry only the fields that are still missing.
  for(const idx of missing){
    if(result[idx]) continue;
    const t=await translateSingleNoCache(src[idx]);
    if(t){result[idx]=t;cache.set(src[idx],t);}
    else {
      const fallback=roughVi(src[idx]);
      if(fallback.toLowerCase()!==src[idx].toLowerCase()) result[idx]=fallback;
    }
  }
  return result;
}


// Translate many independent strings with a very small number of network calls.
// This is used for airport-wide background translation so VI and EN stay available
// without making the user's search wait lounge-by-lounge.
export async function translateManyVi(values=[], {batchChars=3200, batchItems=12}={}){
  const src=values.map(v=>cleanup(v));
  const out=new Array(src.length).fill('');
  const missing=[];
  src.forEach((text,i)=>{
    if(!text) return;
    if(cache.has(text)) out[i]=cache.get(text);
    else missing.push(i);
  });
  if(!missing.length) return out;

  // Deduplicate repeated source strings (common across lounge conditions).
  const firstForText=new Map();
  const unique=[];
  for(const idx of missing){
    const text=src[idx];
    if(!firstForText.has(text)){ firstForText.set(text,idx); unique.push(idx); }
  }

  const batches=[]; let batch=[]; let chars=0;
  for(const idx of unique){
    const n=src[idx].length+32;
    if(batch.length && (batch.length>=batchItems || chars+n>batchChars)){
      batches.push(batch); batch=[]; chars=0;
    }
    batch.push(idx); chars+=n;
  }
  if(batch.length) batches.push(batch);

  async function translateBatch(indices){
    const marker=j=>`[[[LFSEP_${j}]]]`;
    const joined=indices.map((idx,j)=>`${marker(j)}\n${src[idx]}`).join('\n');
    let translated='';
    try{ translated=await googleTranslate(joined); }catch{}
    let ok=false;
    if(translated){
      const re=/\[\[\[\s*LFSEP_(\d+)\s*\]\]\]/gi;
      const matches=[...translated.matchAll(re)];
      if(matches.length===indices.length){
        ok=true;
        for(let m=0;m<matches.length;m++){
          const start=matches[m].index+matches[m][0].length;
          const end=m+1<matches.length?matches[m+1].index:translated.length;
          const t=cleanup(translated.slice(start,end));
          const idx=indices[m];
          if(t && !likelyFailedTranslation(src[idx],t)){
            out[idx]=t; cache.set(src[idx],t);
          } else ok=false;
        }
      }
    }
    if(ok) return;
    // Batch marker failure should not serialize the whole airport. Retry these
    // strings independently; global withSlot still caps network concurrency.
    await Promise.all(indices.map(async idx=>{
      if(out[idx]) return;
      const t=await translateSingleNoCache(src[idx]);
      if(t){ out[idx]=t; cache.set(src[idx],t); }
      else {
        const fallback=roughVi(src[idx]);
        if(fallback.toLowerCase()!==src[idx].toLowerCase()) out[idx]=fallback;
      }
    }));
  }

  await Promise.all(batches.map(translateBatch));

  // Copy translations to duplicate strings.
  for(const idx of missing){
    if(out[idx]) continue;
    const first=firstForText.get(src[idx]);
    if(first!=null && out[first]) out[idx]=out[first];
  }
  return out;
}


// V40 foreground translator: optimized for interactive web requests.
// It translates airport-wide text in a few parallel requests and never falls back
// to serial item-by-item retries, which was the main source of 1-5 minute waits.
async function googleTranslateFastRequest(text, host='https://translate.googleapis.com') {
  const url = new URL('/translate_a/single', host);
  url.searchParams.set('client','gtx');
  url.searchParams.set('sl','en');
  url.searchParams.set('tl','vi');
  url.searchParams.set('dt','t');
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), Number(process.env.TRANSLATE_REQUEST_TIMEOUT_MS || 5200));
  try {
    const r = await fetch(url, {
      method:'POST',
      headers:{'content-type':'application/x-www-form-urlencoded;charset=UTF-8','accept':'application/json,text/plain,*/*','user-agent':'Mozilla/5.0'},
      body:new URLSearchParams({q:text}).toString(),
      signal:controller.signal
    });
    if(!r.ok) throw new Error(`Translate HTTP ${r.status}`);
    return parseGoogle(await r.json());
  } finally { clearTimeout(timer); }
}


// V41 secondary translator. This uses Google's lightweight mobile HTML endpoint,
// independently from translate_a/single. On Render this often succeeds when the
// JSON endpoint is temporarily throttled. It is only used for items still missing
// after the fast batch wave.
function decodeEntities(s=''){
  return String(s)
    .replace(/&amp;/g,'&').replace(/&quot;/g,'"').replace(/&#39;|&#x27;/gi,"'")
    .replace(/&lt;/g,'<').replace(/&gt;/g,'>').replace(/&nbsp;/gi,' ')
    .replace(/&#(\d+);/g,(_,n)=>String.fromCharCode(Number(n)));
}
async function googleMobileTranslateRequest(text){
  const controller=new AbortController();
  const timer=setTimeout(()=>controller.abort(),Number(process.env.TRANSLATE_MOBILE_TIMEOUT_MS||3200));
  try{
    const url=new URL('https://translate.google.com/m');
    url.searchParams.set('sl','en'); url.searchParams.set('tl','vi'); url.searchParams.set('q',text);
    const r=await fetch(url,{headers:{'user-agent':'Mozilla/5.0 (Linux; Android 10; Mobile)','accept':'text/html,*/*'},signal:controller.signal});
    if(!r.ok) throw new Error(`Translate mobile HTTP ${r.status}`);
    const html=await r.text();
    const m=html.match(/<div[^>]*class=["'][^"']*result-container[^"']*["'][^>]*>([\s\S]*?)<\/div>/i);
    if(!m) return '';
    return cleanup(decodeEntities(m[1]).replace(/<[^>]+>/g,' '));
  } finally { clearTimeout(timer); }
}
async function fillMissingWithMobile(src,out,indices,deadlineAt){
  const concurrency=Math.max(2,Math.min(16,Number(process.env.MOBILE_TRANSLATE_CONCURRENCY||10)));
  let cursor=0;
  async function worker(){
    while(Date.now()<deadlineAt){
      const p=cursor++; if(p>=indices.length) return;
      const idx=indices[p]; if(out[idx]||!src[idx]) continue;
      try{
        const t=await googleMobileTranslateRequest(src[idx]);
        if(t && !likelyFailedTranslation(src[idx],t)){out[idx]=t;cache.set(src[idx],t);}
      }catch{}
    }
  }
  await Promise.all(Array.from({length:Math.min(concurrency,indices.length)},()=>worker()));
}

function splitFastBatches(src, indices, maxChars, maxItems){
  const batches=[]; let b=[], chars=0;
  for(const idx of indices){
    const n=src[idx].length+48;
    if(b.length && (b.length>=maxItems || chars+n>maxChars)){batches.push(b);b=[];chars=0;}
    b.push(idx); chars+=n;
  }
  if(b.length) batches.push(b);
  return batches;
}

async function translateFastBatch(src,out,indices,deadlineAt,depth=0){
  if(!indices.length || Date.now()>=deadlineAt) return;
  const marker=j=>`<<<LF${j}>>>`;
  const joined=indices.map((idx,j)=>`${marker(j)}\n${src[idx]}`).join('\n');
  const hosts=['https://translate.googleapis.com','https://translate.google.com'];
  let translated='';
  for(const host of hosts){
    if(Date.now()>=deadlineAt) break;
    try{ translated=await googleTranslateFastRequest(joined,host); }
    catch{ translated=''; }
    if(translated) break;
  }
  if(translated){
    const re=/<<<\s*LF(\d+)\s*>>>/gi;
    const matches=[...translated.matchAll(re)];
    if(matches.length===indices.length){
      let valid=0;
      for(let m=0;m<matches.length;m++){
        const start=matches[m].index+matches[m][0].length;
        const end=m+1<matches.length?matches[m+1].index:translated.length;
        const t=cleanup(translated.slice(start,end));
        const idx=indices[m];
        if(t && !likelyFailedTranslation(src[idx],t)){
          out[idx]=t; cache.set(src[idx],t); valid++;
        }
      }
      if(valid===indices.length) return;
    }
  }
  // If markers were changed by Google, split the batch and retry in parallel.
  // Depth is capped so the foreground request has a predictable upper bound.
  if(depth<2 && indices.length>1 && Date.now()<deadlineAt){
    const mid=Math.ceil(indices.length/2);
    await Promise.all([
      translateFastBatch(src,out,indices.slice(0,mid),deadlineAt,depth+1),
      translateFastBatch(src,out,indices.slice(mid),deadlineAt,depth+1)
    ]);
    return;
  }
  // Last-resort single item attempt, still parallel and bounded.
  if(indices.length===1 && Date.now()<deadlineAt){
    const idx=indices[0];
    for(const host of hosts){
      if(Date.now()>=deadlineAt) break;
      try{
        const t=await googleTranslateFastRequest(src[idx],host);
        if(t && !likelyFailedTranslation(src[idx],t)){out[idx]=t;cache.set(src[idx],t);break;}
      }catch{}
    }
  }
}

export async function translateManyViFast(values=[], {deadlineMs=30000,batchChars=3400,batchItems=10}={}){
  const src=values.map(v=>cleanup(v));
  const out=new Array(src.length).fill('');
  const firstForText=new Map(); const unique=[];
  src.forEach((text,i)=>{
    if(!text) return;
    if(cache.has(text)){out[i]=cache.get(text);return;}
    if(!firstForText.has(text)){firstForText.set(text,i);unique.push(i);}
  });
  if(!unique.length) return out;
  const deadlineAt=Date.now()+Math.max(1000,deadlineMs);

  // Wave 1: smaller batches than V40. This materially reduces marker corruption
  // and avoids one oversized Google request consuming the whole time budget.
  const batches=splitFastBatches(src,unique,batchChars,batchItems);
  const concurrency=Math.max(2,Math.min(8,Number(process.env.FOREGROUND_TRANSLATE_CONCURRENCY||6)));
  let cursor=0;
  async function worker(){
    while(Date.now()<deadlineAt){
      const i=cursor++; if(i>=batches.length) return;
      await translateFastBatch(src,out,batches[i],deadlineAt,0);
    }
  }
  await Promise.all(Array.from({length:Math.min(concurrency,batches.length)},()=>worker()));

  // Wave 2: retry only missing unique strings through a different Google route.
  // These run concurrently and each request has a ~3.2s timeout.
  let missing=unique.filter(i=>!out[i]);
  if(missing.length && Date.now()<deadlineAt-500){
    await fillMissingWithMobile(src,out,missing,deadlineAt);
  }

  // Copy successful translations to duplicate strings.
  for(let i=0;i<src.length;i++){
    if(out[i]||!src[i]) continue;
    const first=firstForText.get(src[i]);
    if(first!=null && out[first]) out[i]=out[first];
  }
  return out;
}
