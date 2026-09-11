import Database from 'better-sqlite3';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const dataDir = path.resolve(__dirname, '../data');
fs.mkdirSync(dataDir, { recursive: true });
const db = new Database(path.join(dataDir, 'lounges.db'));
db.pragma('journal_mode = WAL');

db.exec(`
CREATE TABLE IF NOT EXISTS airports (
  code TEXT PRIMARY KEY,
  name_en TEXT NOT NULL,
  name_vi TEXT,
  terminals_json TEXT DEFAULT '[]',
  updated_at TEXT NOT NULL,
  last_success_at TEXT DEFAULT '',
  source_status TEXT DEFAULT 'cache',
  last_error TEXT DEFAULT ''
);
CREATE TABLE IF NOT EXISTS lounges (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  airport_code TEXT NOT NULL,
  lounge_code TEXT NOT NULL,
  name_en TEXT NOT NULL,
  name_vi TEXT,
  terminal TEXT,
  access_scope TEXT DEFAULT 'all',
  opening_en TEXT,
  opening_vi TEXT,
  location_en TEXT,
  location_vi TEXT,
  conditions_en TEXT,
  conditions_vi TEXT,
  facilities_en TEXT,
  facilities_vi TEXT,
  notes_en TEXT,
  notes_vi TEXT,
  additional_en TEXT,
  additional_vi TEXT,
  source_sections_json TEXT DEFAULT '{}',
  source_sections_vi_json TEXT DEFAULT '{}',
  full_detail_en TEXT DEFAULT '',
  full_detail_vi TEXT DEFAULT '',
  source_url TEXT,
  image_url TEXT,
  image_urls_json TEXT DEFAULT '[]',
  updated_at TEXT NOT NULL,
  UNIQUE(airport_code, lounge_code)
);
CREATE TABLE IF NOT EXISTS sync_runs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  airport_code TEXT NOT NULL,
  started_at TEXT NOT NULL,
  finished_at TEXT,
  status TEXT NOT NULL DEFAULT 'running',
  lounge_count INTEGER DEFAULT 0,
  error TEXT DEFAULT ''
);
`);

const cols = db.prepare(`PRAGMA table_info(lounges)`).all().map(x => x.name);
const airportCols = db.prepare(`PRAGMA table_info(airports)`).all().map(x => x.name);
const migrations = [
  ['access_scope', `ALTER TABLE lounges ADD COLUMN access_scope TEXT DEFAULT 'all'`],
  ['additional_en', `ALTER TABLE lounges ADD COLUMN additional_en TEXT DEFAULT ''`],
  ['additional_vi', `ALTER TABLE lounges ADD COLUMN additional_vi TEXT DEFAULT ''`],
  ['source_sections_json', `ALTER TABLE lounges ADD COLUMN source_sections_json TEXT DEFAULT '{}'`],
  ['source_sections_vi_json', `ALTER TABLE lounges ADD COLUMN source_sections_vi_json TEXT DEFAULT '{}'`],
  ['full_detail_en', `ALTER TABLE lounges ADD COLUMN full_detail_en TEXT DEFAULT ''`],
  ['full_detail_vi', `ALTER TABLE lounges ADD COLUMN full_detail_vi TEXT DEFAULT ''`],
  ['image_urls_json', `ALTER TABLE lounges ADD COLUMN image_urls_json TEXT DEFAULT '[]'`],
];
for (const [name, sql] of migrations) if (!cols.includes(name)) db.exec(sql);
const airportMigrations=[
  ['last_success_at', `ALTER TABLE airports ADD COLUMN last_success_at TEXT DEFAULT ''`],
  ['source_status', `ALTER TABLE airports ADD COLUMN source_status TEXT DEFAULT 'cache'`],
  ['last_error', `ALTER TABLE airports ADD COLUMN last_error TEXT DEFAULT ''`],
];
for (const [name,sql] of airportMigrations) if(!airportCols.includes(name)) db.exec(sql);

export function upsertAirport(a) {
  db.prepare(`INSERT INTO airports(code,name_en,name_vi,terminals_json,updated_at,last_success_at,source_status,last_error)
    VALUES(@code,@name_en,@name_vi,@terminals_json,@updated_at,@last_success_at,@source_status,@last_error)
    ON CONFLICT(code) DO UPDATE SET name_en=excluded.name_en,name_vi=excluded.name_vi,
    terminals_json=excluded.terminals_json,updated_at=excluded.updated_at,last_success_at=excluded.last_success_at,
    source_status=excluded.source_status,last_error=excluded.last_error`).run({
      ...a, terminals_json: JSON.stringify(a.terminals || []), updated_at: a.updated_at || new Date().toISOString(),
      last_success_at:a.last_success_at||'', source_status:a.source_status||'cache', last_error:a.last_error||''
    });
}

export function getLounge(airportCode,loungeCode){
  return db.prepare(`SELECT * FROM lounges WHERE airport_code=? AND lounge_code=?`).get(String(airportCode).toUpperCase(),String(loungeCode));
}

export function upsertLounge(l) {
  db.prepare(`INSERT INTO lounges(
    airport_code,lounge_code,name_en,name_vi,terminal,access_scope,opening_en,opening_vi,location_en,location_vi,
    conditions_en,conditions_vi,facilities_en,facilities_vi,notes_en,notes_vi,additional_en,additional_vi,source_sections_json,source_sections_vi_json,full_detail_en,full_detail_vi,source_url,image_url,image_urls_json,updated_at)
    VALUES(@airport_code,@lounge_code,@name_en,@name_vi,@terminal,@access_scope,@opening_en,@opening_vi,@location_en,@location_vi,
    @conditions_en,@conditions_vi,@facilities_en,@facilities_vi,@notes_en,@notes_vi,@additional_en,@additional_vi,@source_sections_json,@source_sections_vi_json,@full_detail_en,@full_detail_vi,@source_url,@image_url,@image_urls_json,@updated_at)
    ON CONFLICT(airport_code,lounge_code) DO UPDATE SET
    name_en=excluded.name_en,name_vi=excluded.name_vi,terminal=excluded.terminal,access_scope=excluded.access_scope,
    opening_en=excluded.opening_en,opening_vi=excluded.opening_vi,
    location_en=excluded.location_en,location_vi=excluded.location_vi,
    conditions_en=excluded.conditions_en,conditions_vi=excluded.conditions_vi,
    facilities_en=excluded.facilities_en,facilities_vi=excluded.facilities_vi,
    notes_en=excluded.notes_en,notes_vi=excluded.notes_vi,
    additional_en=excluded.additional_en,additional_vi=excluded.additional_vi,
    source_sections_json=excluded.source_sections_json,source_sections_vi_json=excluded.source_sections_vi_json,full_detail_en=excluded.full_detail_en,full_detail_vi=excluded.full_detail_vi,
    source_url=excluded.source_url,image_url=excluded.image_url,image_urls_json=excluded.image_urls_json,updated_at=excluded.updated_at`).run({
      airport_code:l.airport_code, lounge_code:l.lounge_code, name_en:l.name_en || 'Lounge', name_vi:l.name_vi || l.name_en || 'Phòng chờ',
      terminal:l.terminal || '', access_scope:l.access_scope || 'all', opening_en:l.opening_en || '', opening_vi:l.opening_vi || '',
      location_en:l.location_en || '', location_vi:l.location_vi || '', conditions_en:l.conditions_en || '', conditions_vi:l.conditions_vi || '',
      facilities_en:l.facilities_en || '', facilities_vi:l.facilities_vi || '', notes_en:l.notes_en || '', notes_vi:l.notes_vi || '',
      additional_en:l.additional_en || '', additional_vi:l.additional_vi || '', source_sections_json:JSON.stringify(l.source_sections || {}), source_sections_vi_json:JSON.stringify(l.source_sections_vi || {}),
      full_detail_en:l.full_detail_en||'', full_detail_vi:l.full_detail_vi||'', source_url:l.source_url || '', image_url:l.image_url || '', image_urls_json:JSON.stringify(l.image_urls || (l.image_url ? [l.image_url] : [])), updated_at:l.updated_at || new Date().toISOString()
    });
}


export function updateLoungeTerminal(airportCode,loungeCode,terminal=''){
  return db.prepare(`UPDATE lounges SET terminal=? WHERE airport_code=? AND lounge_code=?`).run(String(terminal||''),String(airportCode).toUpperCase(),String(loungeCode)).changes;
}

export function deleteLoungesNotIn(airportCode,codes=[]){
  const airport=String(airportCode).toUpperCase();
  if(!codes.length) return 0;
  const placeholders=codes.map(()=>'?').join(',');
  return db.prepare(`DELETE FROM lounges WHERE airport_code=? AND lounge_code NOT IN (${placeholders})`).run(airport,...codes).changes;
}

export function startSyncRun(airportCode){
  const r=db.prepare(`INSERT INTO sync_runs(airport_code,started_at,status) VALUES(?,?,?)`).run(String(airportCode).toUpperCase(),new Date().toISOString(),'running');
  return Number(r.lastInsertRowid);
}
export function finishSyncRun(id,{status='success',count=0,error=''}){
  db.prepare(`UPDATE sync_runs SET finished_at=?,status=?,lounge_count=?,error=? WHERE id=?`).run(new Date().toISOString(),status,count,String(error||''),id);
}
export function recentSyncRuns(airportCode,limit=10){
  return db.prepare(`SELECT * FROM sync_runs WHERE airport_code=? ORDER BY id DESC LIMIT ?`).all(String(airportCode).toUpperCase(),Number(limit));
}

export function markAirportSyncFailure(code,error=''){
  const a=getAirport(code); if(!a) return;
  db.prepare(`UPDATE airports SET source_status='error', last_error=? WHERE code=?`).run(String(error||''),String(code).toUpperCase());
}

export function searchAirports(q='') {
  const raw = String(q).trim();
  return db.prepare(`SELECT code,name_en,name_vi,terminals_json,updated_at FROM airports
    WHERE code LIKE ? OR name_en LIKE ? OR name_vi LIKE ? ORDER BY CASE WHEN code=? THEN 0 ELSE 1 END, code LIMIT 20`)
    .all(`%${raw.toUpperCase()}%`,`%${raw}%`,`%${raw}%`,raw.toUpperCase())
    .map(x=>({...x,terminals:JSON.parse(x.terminals_json||'[]')}));
}

export function listAirportCodes(){
  return db.prepare(`SELECT code FROM airports ORDER BY code`).all().map(x=>x.code);
}

export function getAirport(code) {
  const a=db.prepare(`SELECT * FROM airports WHERE code=?`).get(String(code).toUpperCase());
  return a?{...a,terminals:JSON.parse(a.terminals_json||'[]')}:null;
}
export function getLounges(code) {
  return db.prepare(`SELECT * FROM lounges WHERE airport_code=? ORDER BY name_en`).all(String(code).toUpperCase())
    .map(x=>({...x,source_sections:safeJson(x.source_sections_json),source_sections_vi:safeJson(x.source_sections_vi_json),image_urls:safeArray(x.image_urls_json,x.image_url)}));
}
function safeJson(s){try{return JSON.parse(s||'{}')}catch{return {}}}
function safeArray(s,fallback=''){try{const a=JSON.parse(s||'[]');return Array.isArray(a)&&a.length?a:(fallback?[fallback]:[])}catch{return fallback?[fallback]:[]}}
export default db;
