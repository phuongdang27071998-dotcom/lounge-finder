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
