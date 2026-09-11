const $=s=>document.querySelector(s), $$=s=>[...document.querySelectorAll(s)];
let airport=null, allLounges=[], lounges=[], selected=[], modalLang='vi', resultLang='vi', scope='all', activeTerminal='all', currentQuery={}, translationPending=false;
const airportInput=$('#airportInput'), suggestions=$('#suggestions'), terminal=$('#terminalSelect'), resultTerminal=$('#resultTerminalSelect');
const fmtDate=iso=>iso?new Date(iso).toLocaleString('vi-VN',{hour:'2-digit',minute:'2-digit',day:'2-digit',month:'2-digit',year:'numeric'}):'--';
const escapeHtml=s=>String(s??'').replace(/[&<>\"]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','\"':'&quot;'}[c]));
const loungeImages=l=>{const a=Array.isArray(l.image_urls)?l.image_urls:[];const out=[...a];if(l.image_url&&!out.includes(l.image_url))out.unshift(l.image_url);return [...new Set(out.filter(Boolean))].slice(0,12);};
let autoTimer;
const airportSuggestCache=new Map();
const terminalOptionCache=new Map();
airportInput.addEventListener('input',()=>{
  clearTimeout(autoTimer);
  const q=airportInput.value.trim();
  // V28: typing never auto-selects an airport. The user must choose one from the dropdown.
  airport=null;
  terminalLoadSeq++;
  setTerminalOptions([],false,'all',{placeholder:'Chọn sân bay trước',disabled:true});
  $('#terminalHint')?.classList.remove('hidden');
  if(!q){suggestions.classList.add('hidden');return;}
  autoTimer=setTimeout(async()=>{
    try{
      const key=q.toLowerCase();
      const items=airportSuggestCache.has(key)?airportSuggestCache.get(key):await fetch('/api/airports?q='+encodeURIComponent(q),{cache:'default'}).then(r=>r.json());
      airportSuggestCache.set(key,items);
      suggestions.innerHTML=items.map(a=>`<button type="button" data-code="${a.code}"><span class="airport-suggestion-main"><b>${escapeHtml(a.name_en||a.code)}</b>${a.airport_city?`<small>${escapeHtml(a.airport_city)}</small>`:''}</span><span class="airport-code">${escapeHtml(a.code)}</span></button>`).join('');
      suggestions.classList.toggle('hidden',!items.length);
      $$('#suggestions button').forEach(el=>el.onclick=()=>selectAirport(items.find(a=>a.code===el.dataset.code)));
    }catch{suggestions.classList.add('hidden');}
  },90);
});
setTerminalOptions([],false,'all',{placeholder:'Chọn sân bay trước',disabled:true});
document.addEventListener('click',e=>{if(!e.target.closest('.autocomplete'))suggestions.classList.add('hidden')});
let terminalLoadSeq=0;
function setTerminalOptions(terms=[],hasUnknown=false,selected='all',opts={}){
  const uniq=[...new Set((terms||[]).filter(Boolean))].sort((a,b)=>a.localeCompare(b,undefined,{numeric:true}));
  if(opts.placeholder && !uniq.length && !hasUnknown){
    terminal.innerHTML=`<option value="all">${escapeHtml(opts.placeholder)}</option>`;
    terminal.disabled=Boolean(opts.disabled);
    terminal.value='all';
    return;
  }
  terminal.innerHTML='<option value="all">Tất cả terminal</option>'+uniq.map(t=>`<option value="${escapeHtml(t)}">${escapeHtml(t)}</option>`).join('')+(hasUnknown?'<option value="__unknown__">Chưa xác định terminal</option>':'');
  terminal.disabled=Boolean(opts.disabled);
  terminal.value=[...terminal.options].some(o=>o.value===selected)?selected:'all';
}
async function loadTerminalOptions(code,{refresh=false,selected='all',showLoading=false}={}){
  const seq=++terminalLoadSeq;
  const cacheKey=`${code}:${refresh?'refresh':'cache'}`;
  if(!refresh && terminalOptionCache.has(cacheKey)){
    const data=terminalOptionCache.get(cacheKey);
    setTerminalOptions(data.terminals||[],Boolean(data.hasUnknown&&data.loungeCount),selected);
    if(data.airport) airport={...(airport||{}),...data.airport};
    return data;
  }
  if(showLoading){
    terminal.disabled=true;
    terminal.innerHTML='<option value="all">Đang tải terminal...</option>';
  }
  try{
    const r=await fetch(`/api/terminal-options?airport=${encodeURIComponent(code)}&refresh=${refresh?'1':'0'}`);
    const data=await r.json().catch(()=>({}));
    if(seq!==terminalLoadSeq) return;
    if(!r.ok) throw new Error(data.error||'Không tải được terminal');
    terminalOptionCache.set(cacheKey,data);
    if(refresh) terminalOptionCache.set(`${code}:cache`,data);
    const keep=terminal.value||selected||'all';
    setTerminalOptions(data.terminals||[],Boolean(data.hasUnknown&&data.loungeCount),keep);
    if(!(data.terminals||[]).length && !data.hasUnknown){ terminal.innerHTML='<option value="all">Tất cả terminal</option>'; terminal.value='all'; }
    if(data.airport) airport={...(airport||{}),...data.airport};
  }catch{
    if(seq!==terminalLoadSeq) return;
    if(showLoading) setTerminalOptions([],false,'all');
  }
}
function selectAirport(a){
  if(!a) return;
  airport=a;
  airportInput.value=`${a.name_en||a.code} (${a.code})`;
  suggestions.classList.add('hidden');
  $('#terminalHint')?.classList.add('hidden');
  const cached=a.terminals||[];
  // Show the Terminal filter on the first screen immediately after selection.
  if(cached.length) setTerminalOptions(cached,false,'all');
  else setTerminalOptions([],false,'all',{placeholder:'Đang tải terminal...',disabled:true});
  // Local DB first, then one-page terminal index in the background. Search itself is never blocked.
  loadTerminalOptions(a.code,{refresh:false,selected:'all',showLoading:false}).then(data=>{
    // Chỉ chạm nguồn khi cache chưa có terminal; tránh khởi chạy tác vụ nặng không cần thiết.
    if(!(data?.terminals||[]).length) loadTerminalOptions(a.code,{refresh:true,selected:terminal.value||'all',showLoading:false});
  });
}
function codeFromInput(){return ((airportInput.value.match(/\(([A-Z]{3})\)/i)||[])[1]||airportInput.value.trim()).toUpperCase();}
$('#searchForm').addEventListener('submit',async e=>{
  e.preventDefault();
  if(!airport?.code){
    suggestions.classList.remove('hidden');
    airportInput.focus();
    return alert('Vui lòng chọn sân bay từ danh sách xổ xuống trước khi tìm kiếm.');
  }
  const code=airport.code;
  const btn=$('#searchBtn'), old=btn.textContent;
  btn.disabled=true; btn.textContent='Đang tra cứu...';
  try{
    currentQuery={airport:code,datetime:$('#datetimeInput').value,terminal:terminal.disabled?'all':(terminal.value||'all')};
    scope='all';
    const data=await loadSearch(); applyData(data); renderResults();
    if(data.hydrating) progressiveHydrate(code);
    // V38: results are always shown; any remaining VI translation completes in background.
    if(data.translationPending) progressiveTranslation(code);
  }catch(err){alert(err.message||'Không thể tra cứu dữ liệu.');}
  finally{btn.disabled=false;btn.textContent=old;}
});
async function loadSearch(extra={}){const params=new URLSearchParams({...currentQuery,terminal:'all',scope:'all',...extra});const ctl=new AbortController();const timer=setTimeout(()=>ctl.abort(),59000);try{const r=await fetch('/api/search?'+params,{signal:ctl.signal});const data=await r.json().catch(()=>({}));if(!r.ok) throw new Error(data.error||'Không thể lấy dữ liệu từ LoungeKey.');return data;}catch(e){if(e?.name==='AbortError') throw new Error('Tra cứu đã vượt quá 59 giây. Vui lòng thử lại; hệ thống sẽ tiếp tục dùng cache ở lần sau.');throw e;}finally{clearTimeout(timer);}}
let hydrateRun=0;

let translationRun=0;
async function progressiveTranslation(code){
  const run=++translationRun;
  // Search results are already visible. Translation refreshes silently in the background.
  const delays=[900,1600,2600,4200,6500,9000,12000];
  for(const delay of delays){
    await new Promise(r=>setTimeout(r,delay));
    if(run!==translationRun || !airport || airport.code!==code) return;
    try{
      const fresh=await loadSearch({autorefresh:'0',translate:'0'});
      if(run!==translationRun) return;
      const oldSelected=new Set(selected);
      applyData(fresh);
      selected=allLounges.filter(x=>oldSelected.has(x.id)||oldSelected.size===0).map(x=>x.id);
      renderResults();
      if(!fresh.translationPending) return;
    }catch{}
  }
}

async function progressiveHydrate(code){
  const run=++hydrateRun;
  const delays=[1800,3200,5200,8000];
  for(const delay of delays){
    await new Promise(r=>setTimeout(r,delay));
    if(run!==hydrateRun || !airport || airport.code!==code) return;
    try{
      const fresh=await loadSearch({autorefresh:'0'});
      const rich=(fresh.lounges||[]).filter(l=>l.opening_en||l.location_en||l.conditions_en||Object.keys(l.source_sections||{}).length).length;
      if(rich){
        const oldSelected=new Set(selected);
        applyData(fresh);
        selected=allLounges.filter(x=>oldSelected.has(x.id)||oldSelected.size===0).map(x=>x.id);
        renderResults();
        if(rich>=(fresh.lounges||[]).length) return;
      }
    }catch{}
  }
}

function applyData(data){airport=data.airport; allLounges=data.lounges; lounges=allLounges; selected=allLounges.map(x=>x.id); activeTerminal=currentQuery.terminal||'all'; translationPending=Boolean(data.translationPending); syncTerminalOptions();}
function syncTerminalOptions(){
  const terms=[...new Set((airport.terminals||[]).concat(allLounges.map(x=>x.terminal).filter(Boolean)))].sort((a,b)=>a.localeCompare(b,undefined,{numeric:true}));
  const hasUnknown=allLounges.some(x=>!x.terminal);
  const opts='<option value="all">Tất cả terminal</option>'+terms.map(t=>`<option value="${escapeHtml(t)}">${escapeHtml(t)}</option>`).join('')+(hasUnknown?'<option value="__unknown__">Chưa xác định terminal</option>':'');
  const current=currentQuery.terminal||'all';
  terminal.innerHTML=opts;
  resultTerminal.innerHTML=opts;
  if([...terminal.options].some(o=>o.value===current))terminal.value=current;
  activeTerminal=[...resultTerminal.options].some(o=>o.value===current)?current:'all';
  resultTerminal.value=activeTerminal;
}
function viText(l,key){
  const vi=String(l[key+'_vi']||'').trim(), en=String(l[key+'_en']||'').trim();
  if(vi && !(en.length>30 && vi.toLowerCase()===en.toLowerCase())) return vi;
  return en?'Đang dịch sang tiếng Việt…':'';
}
function localText(l,key){
  if(resultLang==='en') return l[key+'_en']||'';
  if(resultLang==='vi') return viText(l,key);
  return viText(l,key);
}
function bilingualValue(l,key){
  const vi=viText(l,key), en=String(l[key+'_en']||'').trim();
  if(resultLang!=='bi') return escapeHtml(localText(l,key)||'--');
  return `<div class="bi-value"><div class="bi-vi">${escapeHtml(vi||'--')}</div>${en?`<div class="bi-en"><span>EN</span>${escapeHtml(en)}</div>`:''}</div>`;
}
function scopeLabel(x){return x==='international'?(resultLang==='en'?'International':'Quốc tế'):x==='domestic'?(resultLang==='en'?'Domestic':'Nội địa'):'';}
function availabilityLabel(a){const s=a?.status||'unknown';if(resultLang==='en') return s==='open'?'Open at flight time':s==='closed'?'Closed at flight time':'Hours need checking';return s==='open'?'Mở cửa tại giờ bay':s==='closed'?'Đóng cửa tại giờ bay':'Cần kiểm tra giờ hoạt động';}
function availabilityClass(a){const s=a?.status||'unknown';return s==='open'?'avail-open':s==='closed'?'avail-closed':'avail-unknown';}
function renderResults(){$('#searchView').classList.add('hidden'); $('#resultsView').classList.remove('hidden');$('#airportTitle').textContent=`${airport.name_en} (${airport.code})`;const dt=currentQuery.datetime?new Date(currentQuery.datetime).toLocaleString('vi-VN',{weekday:'short',hour:'2-digit',minute:'2-digit',day:'2-digit',month:'2-digit'}):'Không chọn giờ bay';const term=currentQuery.terminal&&currentQuery.terminal!=='all'?currentQuery.terminal:'Tất cả terminal';$('#summaryLine').textContent=`${term} · ${dt} · ${lounges.length} phòng chờ phù hợp`;const sourceText=airport.last_success_at?('Nguồn LoungeKey: '+fmtDate(airport.last_success_at)):'Nguồn LoungeKey: chưa đồng bộ thành công';$('#updatedTop').textContent=sourceText;renderCards();}
function terminalLabel(l){return l.terminal||(resultLang==='vi'?'Chưa xác định terminal':'Terminal not specified');}
function loungeCard(l){
  const scopeTag=scopeLabel(l.access_scope), showAvail=Boolean(currentQuery.datetime);
  const availTag=showAvail?`<span class="availability ${availabilityClass(l.availability)}">${availabilityLabel(l.availability)}</span>`:'';
  const name=resultLang==='en'?l.name_en:(l.name_vi||l.name_en);
  const srcLabel=resultLang==='en'?'Source link':'Xem link gốc';
  const detailLabel=resultLang==='en'?'View full details':'Xem đầy đủ thông tin';
  return `<article class="card"><input class="check" type="checkbox" data-id="${l.id}" ${selected.includes(l.id)?'checked':''}><div class="card-main"><div class="card-top"><div><h3>${escapeHtml(name)}</h3><div class="tag-row">${l.terminal?`<span class="terminal-tag">${escapeHtml(l.terminal)}</span>`:`<span class="terminal-tag terminal-unknown">${resultLang==='en'?'Terminal not specified':'Chưa xác định terminal'}</span>`}${scopeTag?`<span class="scope-tag">${scopeTag}</span>`:''}${availTag}${translationPending&&resultLang!=='en'?'<span class="translation-tag">Đang dịch VI…</span>':''}</div></div><div class="meta"><span class="updated">Cập nhật: ${fmtDate(l.updated_at)}</span><a class="source" target="_blank" rel="noopener" href="${escapeHtml(l.source_url)}">${srcLabel}</a></div></div><div class="info"><span class="icon">◷</span><div>${bilingualValue(l,'opening')}</div></div><div class="info"><span class="icon">⌖</span><div>${bilingualValue(l,'location')}</div></div><details><summary>${detailLabel}</summary>${detailHtml(l)}</details></div></article>`;
}
function renderCards(){
  lounges=allLounges.filter(l=>{
    const scopeOk=scope==='all'||l.access_scope==='all'||l.access_scope===scope;
    const terminalOk=activeTerminal==='all'||(activeTerminal==='__unknown__'?!l.terminal:l.terminal===activeTerminal);
    return scopeOk&&terminalOk;
  });
  $('#summaryLine').textContent=$('#summaryLine').textContent.replace(/\d+ phòng chờ(?: phù hợp)?$/,`${lounges.length} phòng chờ phù hợp`);
  $('#emptyState').classList.toggle('hidden',lounges.length>0);
  const groups=new Map();
  for(const l of lounges){const key=l.terminal||'__unknown__';if(!groups.has(key))groups.set(key,[]);groups.get(key).push(l);}
  const ordered=[...groups.entries()].sort(([a],[b])=>{if(a==='__unknown__')return 1;if(b==='__unknown__')return -1;return a.localeCompare(b,undefined,{numeric:true});});
  $('#cards').innerHTML=ordered.map(([key,items])=>`<section class="terminal-group"><div class="terminal-group-head"><h3>${escapeHtml(key==='__unknown__'?(resultLang==='vi'?'Chưa xác định terminal':'Terminal not specified'):key)}</h3><span>${items.length} ${resultLang==='vi'?'phòng chờ':'lounges'}</span></div>${items.map(loungeCard).join('')}</section>`).join('');
  $$('.check').forEach(c=>c.onchange=()=>{const id=Number(c.dataset.id);selected=c.checked?[...new Set([...selected,id])]:selected.filter(x=>x!==id)});
}
$('#cards').onclick=e=>{const b=e.target.closest('.gallery-thumb');if(!b)return;const g=b.closest('.lounge-gallery');const main=g?.querySelector('.gallery-main img');if(main)main.src=b.dataset.src||b.querySelector('img')?.src||main.src;g?.querySelectorAll('.gallery-thumb').forEach(x=>x.classList.toggle('active',x===b));};
function sectionKey(title=''){return String(title).toLowerCase().replace(/[:：]\s*$/,'').trim();}
function fallbackSectionVi(l,title){
  const k=sectionKey(title);
  if(k.startsWith('opening')||k==='hours of operation') return viText(l,'opening');
  if(k==='location'||k.startsWith('where')) return viText(l,'location');
  if(k.startsWith('conditions')||k.startsWith('access conditions')) return viText(l,'conditions');
  if(k.startsWith('important')||k.startsWith('please note')) return viText(l,'notes');
  if(k.startsWith('additional')||k.startsWith('other information')||k.startsWith('more information')) return viText(l,'additional');
  return 'Đang dịch sang tiếng Việt…';
}
function fullSourceSections(l,lang=resultLang){
  const sections=l.source_sections&&typeof l.source_sections==='object'?l.source_sections:{};
  const vi=l.source_sections_vi&&typeof l.source_sections_vi==='object'?l.source_sections_vi:{};
  const hidden=/^(facilities?|amenities|lounge facilities)$/i;
  const rows=[];
  for(const [title,value] of Object.entries(sections)){
    if(!String(value||'').trim() || hidden.test(String(title).trim())) continue;
    const k=sectionKey(title), vv=vi[title]||{};
    const titleVi=vv.title_vi||({'opening hours':'Giờ hoạt động','location':'Vị trí','conditions':'Điều kiện sử dụng','important information':'Thông tin quan trọng','additional information':'Thông tin bổ sung','additional info':'Thông tin bổ sung'}[k]||title);
    const valueVi=String(vv.value_vi||fallbackSectionVi(l,title)||'').trim();
    if(lang==='en') rows.push({title,value});
    else if(lang==='vi') rows.push({title:titleVi,value:valueVi});
    else rows.push({title:titleVi,value:valueVi,enTitle:title,enValue:value});
  }
  if(!rows.length){
    const defs=[['Giờ hoạt động','Opening Hours','opening'],['Vị trí','Location','location'],['Điều kiện sử dụng','Conditions','conditions'],['Thông tin quan trọng','Important Information','notes'],['Thông tin bổ sung','Additional Information','additional']];
    for(const [viTitle,enTitle,key] of defs){
      const en=String(l[key+'_en']||'').trim(); if(!en) continue;
      const vv=viText(l,key);
      if(lang==='en') rows.push({title:enTitle,value:en});
      else if(lang==='vi') rows.push({title:viTitle,value:vv});
      else rows.push({title:viTitle,value:vv,enTitle,enValue:en});
    }
  }
  return rows;
}

function detailHtml(l){
 const rows=fullSourceSections(l,resultLang);
 let html=rows.map(({title,value,enTitle,enValue})=>`<div class="source-text-block"><b>${escapeHtml(title)}:</b><p>${escapeHtml(value).replace(/\n/g,'<br>')}</p>${resultLang==='bi'&&enValue?`<div class="bi-detail-en"><span>EN · ${escapeHtml(enTitle||'')}</span><p>${escapeHtml(enValue).replace(/\n/g,'<br>')}</p></div>`:''}</div>`).join('');
 const imgs=loungeImages(l);
 if(imgs.length) html+=`<div class="lounge-gallery" data-gallery="${l.id}"><b>${resultLang==='en'?'Lounge images':'Hình ảnh phòng chờ'}:</b><div class="gallery-main"><img loading="lazy" decoding="async" src="${escapeHtml(imgs[0])}" alt="${escapeHtml(l.name_en)}"></div>${imgs.length>1?`<div class="gallery-thumbs">${imgs.map((u,i)=>`<button type="button" class="gallery-thumb ${i===0?'active':''}" data-src="${escapeHtml(u)}"><img loading="lazy" decoding="async" src="${escapeHtml(u)}" alt=""></button>`).join('')}</div>`:''}</div>`;
 if(!html) html=`<div class="detail-missing">${resultLang==='en'?'Details are not available yet. The system will retry automatically on search.':'Chưa có dữ liệu chi tiết. Hệ thống sẽ tự đồng bộ lại khi tra cứu.'}</div>`;
 return '<div class="details-body">'+html+'</div>';
}

$('#backBtn').onclick=()=>{$('#resultsView').classList.add('hidden');$('#searchView').classList.remove('hidden')};
$$('[data-result-lang]').forEach(b=>b.onclick=()=>{resultLang=b.dataset.resultLang;$$('[data-result-lang]').forEach(x=>x.classList.toggle('active',x===b));renderCards()});
$$('#scopeTabs button').forEach(b=>b.onclick=()=>{scope=b.dataset.filter;$$('#scopeTabs button').forEach(x=>x.classList.toggle('active',x===b));renderCards()});
resultTerminal.onchange=()=>{activeTerminal=resultTerminal.value;renderCards();};

$('#summaryBtn').onclick=()=>{if(!selected.length)return alert('Vui lòng chọn ít nhất 1 phòng chờ.');$('#modal').classList.remove('hidden');$('#modal').setAttribute('aria-hidden','false');renderSummary()};
$('#closeModal').onclick=closeModal;$('#modal').onclick=e=>{if(e.target===$('#modal'))closeModal()};function closeModal(){$('#modal').classList.add('hidden');$('#modal').setAttribute('aria-hidden','true')}
$$('.lang').forEach(b=>b.onclick=()=>{modalLang=b.dataset.lang;$$('.lang').forEach(x=>x.classList.toggle('active',x===b));renderSummary()});$$('[data-cmd]').forEach(b=>b.onclick=()=>{document.execCommand(b.dataset.cmd,false,null);$('#summaryText').focus()});
function renderSummary(){
 const list=allLounges.filter(l=>selected.includes(l.id)), bi=modalLang==='bi', vi=modalLang!=='en';
 $('#modalTitle').textContent=`${modalLang==='en'?'Lounge summary':'Tổng hợp thông tin'} (${list.length} ${modalLang==='en'?'lounges':'phòng chờ'})`;
 $('#summaryText').innerHTML=list.map((l,i)=>{
   const rows=fullSourceSections(l,modalLang);
   const detailUrl=l.source_url||'';
   const detailLabel=modalLang==='en'?'Detailed information':'Thông tin chi tiết';
   const detailBlock=detailUrl?`<p><strong>${detailLabel}:</strong><br><a href="${escapeHtml(detailUrl)}" target="_blank" rel="noopener">${escapeHtml(detailUrl)}</a></p>`:'';
   return `<section class="summary-section"><p><strong>${i+1}. ${escapeHtml(vi?(l.name_vi||l.name_en):l.name_en)}</strong><br>${escapeHtml(airport.name_en)} (${airport.code})${l.terminal?` · ${escapeHtml(l.terminal)}`:''}</p>${rows.map(({title,value,enTitle,enValue})=>`<p><strong>${escapeHtml(title)}:</strong><br>${escapeHtml(value).replace(/\n/g,'<br>')}${bi&&enValue?`<br><span class="summary-en"><strong>EN · ${escapeHtml(enTitle||'')}:</strong><br>${escapeHtml(enValue).replace(/\n/g,'<br>')}</span>`:''}</p>`).join('')}${detailBlock}</section>`;
 }).join('<hr>');
}
$('#copyBtn').onclick=async()=>{const text=$('#summaryText').innerText.trim();try{await navigator.clipboard.writeText(text);}catch{const range=document.createRange();range.selectNodeContents($('#summaryText'));const sel=getSelection();sel.removeAllRanges();sel.addRange(range);document.execCommand('copy');sel.removeAllRanges();}$('#copyStatus').textContent=modalLang==='vi'?'Đã sao chép':'Copied'; setTimeout(()=>$('#copyStatus').textContent='',1500);};
