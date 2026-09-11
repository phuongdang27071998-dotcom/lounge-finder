const DAY_INDEX = {sun:0,sunday:0,mon:1,monday:1,tue:2,tues:2,tuesday:2,wed:3,wednesday:3,thu:4,thur:4,thurs:4,thursday:4,fri:5,friday:5,sat:6,saturday:6};

const clean = (s='') => String(s).replace(/[–—]/g,'-').replace(/\s+/g,' ').trim();
const minutes = hhmm => { const [h,m]=hhmm.split(':').map(Number); return h*60+m; };
const inRange = (now,start,end) => {
  const s=minutes(start), e=minutes(end);
  if (s===e) return true;
  if (e>s) return now>=s && now<=e;
  return now>=s || now<=e; // overnight range, e.g. 22:00-02:00
};

function parseLocalDateTime(value='') {
  const m=String(value).match(/^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})/);
  if(!m) return null;
  const [,y,mo,d,h,mi]=m;
  // Date.UTC avoids applying the server timezone to a user-entered airport-local clock value.
  const day=new Date(Date.UTC(Number(y),Number(mo)-1,Number(d))).getUTCDay();
  return {day, minute:Number(h)*60+Number(mi), hhmm:`${h}:${mi}`};
}

function expandDayExpr(expr='') {
  const s=expr.toLowerCase().replace(/\./g,'').trim();
  if(!s || /daily|every day|7 days/.test(s)) return [0,1,2,3,4,5,6];
  const found=[];
  const range=s.match(/(sunday|monday|tuesday|wednesday|thursday|friday|saturday|sun|mon|tue|tues|wed|thu|thur|thurs|fri|sat)\s*-\s*(sunday|monday|tuesday|wednesday|thursday|friday|saturday|sun|mon|tue|tues|wed|thu|thur|thurs|fri|sat)/i);
  if(range){
    let a=DAY_INDEX[range[1].toLowerCase()], b=DAY_INDEX[range[2].toLowerCase()];
    if(a!=null && b!=null){ let i=a; for(let guard=0;guard<7;guard++){found.push(i); if(i===b) break; i=(i+1)%7;} }
  }
  for(const token of s.match(/sunday|monday|tuesday|wednesday|thursday|friday|saturday|sun|mon|tue|tues|wed|thu|thur|thurs|fri|sat/gi)||[]){
    const d=DAY_INDEX[token.toLowerCase()]; if(d!=null && !found.includes(d)) found.push(d);
  }
  return found;
}

/**
 * Best-effort parser for LoungeKey-style opening-hours text.
 * Returns high-confidence open/closed only when the text is structurally clear;
 * otherwise returns unknown so the UI does not incorrectly hide a lounge.
 */
export function evaluateOpeningHours(text='', datetimeLocal='') {
  const raw=clean(text), dt=parseLocalDateTime(datetimeLocal);
  if(!dt || !raw) return {status:'unknown',confidence:'low',reason:'insufficient-data'};
  const lower=raw.toLowerCase();

  // Explicit 24-hour opening is considered open unless the text also declares a closure.
  if(/(?:open\s*)?24\s*hours?\s*(?:daily|a day|each day|every day)?/.test(lower) && !/closed|closure/.test(lower)) {
    return {status:'open',confidence:'high',reason:'24-hours'};
  }

  // Common simple pattern: "06:00 - 20:00 daily" or "daily 06:00 - 20:00".
  const ranges=[...raw.matchAll(/\b([01]?\d|2[0-3]):([0-5]\d)\s*-\s*([01]?\d|2[0-3]):([0-5]\d)\b/g)]
    .map(m=>({start:`${m[1].padStart(2,'0')}:${m[2]}`,end:`${m[3].padStart(2,'0')}:${m[4]}`,index:m.index||0}));
  if(!ranges.length) return {status:'unknown',confidence:'low',reason:'no-parseable-range'};

  // Avoid misclassifying incidental times such as peak periods, shower windows, or stay limits.
  const exclusionWords=/peak|busy|shower|stay|suite|nap pod|maximum|limited to|access may|restricted|last admission|food service|bar service/i;
  const usable=ranges.filter(r=>{
    const context=raw.slice(Math.max(0,r.index-80),Math.min(raw.length,r.index+80));
    return !exclusionWords.test(context);
  });
  if(!usable.length) return {status:'unknown',confidence:'low',reason:'ranges-look-incidental'};

  const hasDaily=/daily|every day|each day|7 days/i.test(raw);
  if(hasDaily){
    const open=usable.some(r=>inRange(dt.minute,r.start,r.end));
    return {status:open?'open':'closed',confidence:'high',reason:'daily-range',ranges:usable};
  }

  // Parse weekday-specific clauses around each range. This intentionally stays conservative.
  const clauses=raw.split(/(?<=[.;])\s+/);
  let matchedDayClause=false, isOpen=false;
  for(const clause of clauses){
    const cranges=[...clause.matchAll(/\b([01]?\d|2[0-3]):([0-5]\d)\s*-\s*([01]?\d|2[0-3]):([0-5]\d)\b/g)];
    if(!cranges.length || exclusionWords.test(clause)) continue;
    const days=expandDayExpr(clause);
    if(!days.length) continue;
    if(days.includes(dt.day)){
      matchedDayClause=true;
      for(const m of cranges){ if(inRange(dt.minute,`${m[1].padStart(2,'0')}:${m[2]}`,`${m[3].padStart(2,'0')}:${m[4]}`)) isOpen=true; }
    }
  }
  if(matchedDayClause) return {status:isOpen?'open':'closed',confidence:'medium',reason:'weekday-range'};
  return {status:'unknown',confidence:'low',reason:'ambiguous-schedule'};
}

export function availabilityLabel(status, lang='vi'){
  if(lang==='en') return status==='open'?'Open at flight time':status==='closed'?'Closed at flight time':'Hours need checking';
  return status==='open'?'Mở cửa tại giờ bay':status==='closed'?'Đóng cửa tại giờ bay':'Cần kiểm tra giờ hoạt động';
}
