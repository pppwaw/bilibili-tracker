import {DatabaseSync} from 'node:sqlite';
import {mkdirSync} from 'node:fs';
import {dirname,resolve} from 'node:path';
import type {Dashboard,PageProgress,Settings,Video,Season,Override} from './types.ts';
import {calculateStatus} from './progress.ts';
let instance:DatabaseSync|undefined;
export const now=()=>Math.floor(Date.now()/1000);
export function db():DatabaseSync{
 if(instance)return instance;
 const path=resolve(/* turbopackIgnore: true */ process.env.DATABASE_PATH||'./data/bili.db');
 mkdirSync(dirname(path),{recursive:true,mode:0o700});
 const conn=new DatabaseSync(path,{timeout:10000});
 conn.exec('PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=10000;');
 conn.exec(`
 CREATE TABLE IF NOT EXISTS migrations(version INTEGER PRIMARY KEY);
 CREATE TABLE IF NOT EXISTS kv(key TEXT PRIMARY KEY,value TEXT NOT NULL);
 CREATE TABLE IF NOT EXISTS seasons(id TEXT PRIMARY KEY,mid TEXT NOT NULL,title TEXT NOT NULL,cover TEXT NOT NULL DEFAULT '',author TEXT NOT NULL DEFAULT '',active INTEGER NOT NULL DEFAULT 1,synced_at INTEGER);
 CREATE TABLE IF NOT EXISTS videos(bvid TEXT PRIMARY KEY,title TEXT NOT NULL,cover TEXT NOT NULL DEFAULT '',author TEXT NOT NULL DEFAULT '',duration INTEGER NOT NULL DEFAULT 0,published_at INTEGER NOT NULL DEFAULT 0,discovered_at INTEGER NOT NULL,manual_state TEXT,details_at INTEGER);
 CREATE TABLE IF NOT EXISTS season_videos(season_id TEXT REFERENCES seasons(id),bvid TEXT REFERENCES videos(bvid),position INTEGER NOT NULL,PRIMARY KEY(season_id,bvid));
 CREATE TABLE IF NOT EXISTS pages(bvid TEXT REFERENCES videos(bvid),cid TEXT NOT NULL,page INTEGER NOT NULL,title TEXT NOT NULL,duration INTEGER NOT NULL,progress INTEGER,completed INTEGER NOT NULL DEFAULT 0,observed_at INTEGER NOT NULL DEFAULT 0,active INTEGER NOT NULL DEFAULT 1,PRIMARY KEY(bvid,cid));
 CREATE TABLE IF NOT EXISTS observations(bvid TEXT NOT NULL,cid TEXT NOT NULL,view_at INTEGER NOT NULL,progress INTEGER NOT NULL,duration INTEGER NOT NULL,raw TEXT NOT NULL,PRIMARY KEY(bvid,cid,view_at));
 CREATE TABLE IF NOT EXISTS jobs(id INTEGER PRIMARY KEY AUTOINCREMENT,kind TEXT NOT NULL,status TEXT NOT NULL DEFAULT 'pending',requested_at INTEGER NOT NULL,started_at INTEGER,finished_at INTEGER,message TEXT NOT NULL DEFAULT '');
 CREATE INDEX IF NOT EXISTS jobs_pending ON jobs(status,requested_at);
 CREATE TABLE IF NOT EXISTS sessions(token_hash TEXT PRIMARY KEY,expires_at INTEGER NOT NULL);
 CREATE TABLE IF NOT EXISTS login_attempts(id INTEGER PRIMARY KEY CHECK(id=1),failures INTEGER NOT NULL,window_at INTEGER NOT NULL);
 CREATE TABLE IF NOT EXISTS qr_requests(id TEXT PRIMARY KEY,qr_key TEXT NOT NULL,expires_at INTEGER NOT NULL);
 INSERT OR IGNORE INTO migrations(version) VALUES(1);`);
 if(!conn.prepare('SELECT version FROM migrations WHERE version=2').get()){
 conn.exec(`BEGIN IMMEDIATE;
 CREATE TABLE IF NOT EXISTS season_sections(season_id TEXT REFERENCES seasons(id),id TEXT,title TEXT NOT NULL,position INTEGER NOT NULL,PRIMARY KEY(season_id,id));
 CREATE TABLE IF NOT EXISTS season_video_sections(season_id TEXT,bvid TEXT,section_id TEXT,PRIMARY KEY(season_id,bvid));
 CREATE TABLE IF NOT EXISTS detail_attempts(bvid TEXT PRIMARY KEY,attempted_at INTEGER NOT NULL);
 INSERT OR IGNORE INTO migrations(version) VALUES(2);COMMIT;`);
 }
 instance=conn;return conn;
}
export function getKV(key:string,fallback=''):string{return db().prepare('SELECT value FROM kv WHERE key=?').get(key)?.value as string??fallback}
export function setKV(key:string,value:string){db().prepare('INSERT INTO kv(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').run(key,value)}
export function selectedSeasons():string[]{return JSON.parse(getKV('selected_seasons','[]'))}
export function selectNewSeason(id:string){
 if(getKV('new_season_default')==='true'&&!seasonSelected(id))setKV('selected_seasons',JSON.stringify([...selectedSeasons(),id]));
}
export function seasonSelected(id:string){return selectedSeasons().includes(id)}
export function settings():Settings{return JSON.parse(getKV('settings','{"threshold":95,"historyMinutes":5,"seasonMinutes":15}'))}
export function transaction<T>(fn:()=>T):T{db().exec('BEGIN IMMEDIATE');try{const value=fn();db().exec('COMMIT');return value}catch(e){db().exec('ROLLBACK');throw e}}
export function enqueue(kind:'history'|'seasons'|'details'|'likes'){return transaction(()=>{
 const existing=db().prepare("SELECT id FROM jobs WHERE kind=? AND status IN ('pending','running') LIMIT 1").get(kind);
 if(existing)return Number(existing.id);
 return Number(db().prepare('INSERT INTO jobs(kind,requested_at) VALUES(?,?)').run(kind,now()).lastInsertRowid);
})}
export function setOverride(bvid:string,state:Override){return db().prepare('UPDATE videos SET manual_state=? WHERE bvid=?').run(state,bvid).changes}
export function selectedVideoIds(){const selected=new Set(selectedSeasons());return [...new Set(db().prepare('SELECT sv.bvid,sv.season_id FROM season_videos sv JOIN seasons s ON s.id=sv.season_id WHERE s.active=1').all().filter(r=>selected.has(String(r.season_id))).map(r=>String(r.bvid)))]}
export function setOverrides(ids:string[],state:Override){
 if(![null,'unwatched','watching','completed','ignored'].includes(state))throw new Error('观看状态无效');
 if(!Array.isArray(ids)||!ids.length||ids.length>50000||!ids.every(x=>typeof x==='string'))throw new Error('请选择有效的视频');
 const unique=[...new Set(ids)];return transaction(()=>{
 const exists=db().prepare('SELECT bvid FROM videos WHERE bvid=?');if(unique.some(id=>!exists.get(id)))throw new Error('部分视频不存在，请刷新后重试');
 for(const id of unique)setOverride(id,state);return unique.length;
 });
}
export function pendingDetails(){
 const selected=new Set(selectedVideoIds());
 const regular=db().prepare('SELECT v.bvid FROM videos v LEFT JOIN detail_attempts a ON a.bvid=v.bvid WHERE (v.details_at IS NULL OR v.details_at<?) AND (a.attempted_at IS NULL OR a.attempted_at<?) ORDER BY v.details_at IS NOT NULL,v.published_at DESC').all(now()-7*86400,now()-86400).filter(r=>selected.has(String(r.bvid))).map(r=>String(r.bvid));
 const seeds=new Map<string,string>();
 for(const row of db().prepare('SELECT sv.season_id,sv.bvid FROM season_videos sv JOIN seasons s ON s.id=sv.season_id LEFT JOIN detail_attempts a ON a.bvid=sv.bvid WHERE s.active=1 AND NOT EXISTS(SELECT 1 FROM season_sections ss WHERE ss.season_id=sv.season_id) AND (a.attempted_at IS NULL OR a.attempted_at<?) ORDER BY sv.position').all(now()-86400))if(selected.has(String(row.bvid))&&seasonSelected(String(row.season_id))&&!seeds.has(String(row.season_id)))seeds.set(String(row.season_id),String(row.bvid));
 return [...new Set([...seeds.values(),...regular])];
}
export function reportProgress(label:string,done:number,total:number){
 setKV('worker_progress',JSON.stringify({label,done,total,updatedAt:now()}));
 db().prepare("UPDATE jobs SET message=? WHERE status='running'").run(label+(total?' '+done+'/'+total:''));
}
export function dashboard():Dashboard{
 const config=settings(),baseline=Number(getKV('baseline','0')),pageMap=new Map<string,PageProgress[]>();
 for(const row of db().prepare('SELECT * FROM pages WHERE active=1 ORDER BY page').all()){const key=String(row.bvid),list=pageMap.get(key)??[];list.push(row as unknown as PageProgress);pageMap.set(key,list)}
 const links=db().prepare('SELECT * FROM season_videos ORDER BY position').all(),videoSeasons=new Map<string,string[]>();
 for(const l of links){const key=String(l.bvid);videoSeasons.set(key,[...(videoSeasons.get(key)??[]),String(l.season_id)])}
 const videos=db().prepare('SELECT * FROM videos ORDER BY published_at DESC,discovered_at DESC').all().map(row=>{
 const pages=pageMap.get(String(row.bvid))??[],override=(row.manual_state==='unknown'?'unwatched':row.manual_state) as Override;
 return {...row,override,pages,seasons:videoSeasons.get(String(row.bvid))??[],...calculateStatus(pages,config.threshold,Number(row.published_at),baseline,override)} as unknown as Video;
 });
 const seasons=db().prepare('SELECT * FROM seasons ORDER BY title').all().map(s=>{const members=videos.filter(v=>v.seasons.includes(String(s.id)));const sections=db().prepare('SELECT * FROM season_sections WHERE season_id=? ORDER BY position').all(String(s.id)).map(section=>({id:String(section.id),title:String(section.title),videoIds:db().prepare('SELECT bvid FROM season_video_sections WHERE season_id=? AND section_id=?').all(String(s.id),String(section.id)).map(r=>String(r.bvid))}));return {...s,sections,sync_enabled:seasonSelected(String(s.id)),total:members.length,completed:members.filter(v=>v.status==='completed').length,videoIds:links.filter(l=>String(l.season_id)===String(s.id)).map(l=>String(l.bvid))} as unknown as Season});
 return {videos,seasons,workerProgress:JSON.parse(getKV('worker_progress','null')),cooldownUntil:Number(getKV('cooldown_until','0')),likesScan:JSON.parse(getKV('likes_scan','null')),detailsPending:pendingDetails().length,newSeasonDefault:getKV('new_season_default')==='true',settings:config,account:{connected:!!getKV('credential'),state:getKV('account_state','disconnected'),name:getKV('account_name'),face:getKV('account_face')},jobs:db().prepare('SELECT id,kind,status,requested_at,finished_at,message FROM jobs ORDER BY id DESC LIMIT 25').all() as unknown as Dashboard['jobs'],workerHeartbeat:Number(getKV('worker_heartbeat','0')),baseline};
}
