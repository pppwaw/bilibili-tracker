import {createHash} from 'node:crypto';
import {BiliClient,BiliError} from './bilibili.ts';
import type {BiliHistory,VideoDetail,Collected} from './bilibili.ts';
import {db,getKV,setKV,settings,transaction,now,seasonSelected,selectNewSeason,pendingDetails,selectedVideoIds,enqueue,reportProgress} from './db.ts';
import {decrypt} from './crypto.ts';
export function credentialClient(){const value=getKV('credential');if(!value)throw new BiliError(-101,'请先绑定 B 站账号');return new BiliClient(decrypt(value))}
export function upsertDetail(detail:VideoDetail){
 if(!detail.bvid||!Array.isArray(detail.pages)||!detail.pages.length)throw new Error('视频分 P 数据不完整');
 transaction(()=>{
 db().prepare(`INSERT INTO videos(bvid,title,cover,author,duration,published_at,discovered_at,details_at) VALUES(?,?,?,?,?,?,?,?)
 ON CONFLICT(bvid) DO UPDATE SET title=excluded.title,cover=excluded.cover,author=excluded.author,duration=excluded.duration,published_at=excluded.published_at,details_at=excluded.details_at`).run(detail.bvid,detail.title,detail.pic||'',detail.owner?.name||'',detail.duration,detail.pubdate,now(),now());
 db().prepare('UPDATE pages SET active=0 WHERE bvid=?').run(detail.bvid);
 if(detail.ugc_season&&db().prepare('SELECT id FROM seasons WHERE id=?').get(String(detail.ugc_season.id))){
 const seasonId=String(detail.ugc_season.id);db().prepare('DELETE FROM season_sections WHERE season_id=?').run(seasonId);db().prepare('DELETE FROM season_video_sections WHERE season_id=?').run(seasonId);
 for(const [position,section] of detail.ugc_season.sections.entries()){
 db().prepare('INSERT INTO season_sections(season_id,id,title,position) VALUES(?,?,?,?)').run(seasonId,String(section.id),section.title,position);
 for(const episode of section.episodes)if(episode.bvid)db().prepare('INSERT OR REPLACE INTO season_video_sections(season_id,bvid,section_id) VALUES(?,?,?)').run(seasonId,episode.bvid,String(section.id));
 }
 }
 for(const p of detail.pages)db().prepare(`INSERT INTO pages(bvid,cid,page,title,duration) VALUES(?,?,?,?,?)
 ON CONFLICT(bvid,cid) DO UPDATE SET page=excluded.page,title=excluded.title,duration=excluded.duration,active=1`).run(detail.bvid,String(p.cid),p.page,p.part,p.duration);
 // Do not infer previous P completion from the most recently viewed P.
 for(const p of detail.pages){const observations=db().prepare('SELECT * FROM observations WHERE bvid=? AND cid=? ORDER BY view_at').all(detail.bvid,String(p.cid));for(const o of observations)applyProgress(detail.bvid,String(p.cid),Number(o.progress),Number(o.view_at))}
 });
}
function applyProgress(bvid:string,cid:string,progress:number,viewAt:number){
 const p=db().prepare('SELECT * FROM pages WHERE bvid=? AND cid=?').get(bvid,cid);if(!p)return;
 const duration=Number(p.duration);
 // Only Bilibili's explicit completion sentinel latches completion. The configurable
 // percentage is evaluated from max observed progress, so changing threshold works.
 const complete=progress===-1?1:0;
 const seconds=complete?duration:Math.max(0,progress);
 db().prepare('UPDATE pages SET progress=MAX(COALESCE(progress,0),?),completed=MAX(completed,?),observed_at=MAX(observed_at,?) WHERE bvid=? AND cid=?').run(seconds,complete,viewAt,bvid,cid);
}
export function recordHistory(item:BiliHistory){
 item={...item,bvid:item.history?.bvid||item.bvid};
 if(item.history?.business!=='archive'||!item.bvid||!item.history.cid)return false;
 if(!Number.isFinite(item.progress)||item.progress < -1)return false;
 const cid=String(item.history.cid);
 const raw=JSON.stringify({bvid:item.bvid,cid,page:item.history.page,progress:item.progress,duration:item.duration,view_at:item.view_at});
 transaction(()=>{
 db().prepare(`INSERT INTO observations(bvid,cid,view_at,progress,duration,raw) VALUES(?,?,?,?,?,?) ON CONFLICT(bvid,cid,view_at) DO UPDATE SET progress=CASE WHEN observations.progress=-1 OR excluded.progress=-1 THEN -1 ELSE MAX(observations.progress,excluded.progress) END,duration=excluded.duration,raw=excluded.raw`).run(item.bvid,cid,item.view_at,item.progress,item.duration,raw);
 applyProgress(item.bvid,cid,item.progress,item.view_at);
 });
 return true;
}
function baselineIfReady(){if(!getKV('baseline')&&getKV('history_success')&&getKV('seasons_success'))setKV('baseline',String(now()))}
export async function syncHistory(client:BiliClient){
 const nav=await client.nav();setKV('account_name',nav.uname);setKV('account_face',nav.face||'');setKV('account_state','connected');
 let cursor={max:0,view_at:0,business:''},count=0;const visited=new Set<string>();
 for(let page=0;page<200;page++){
 const data=await client.history(cursor);
 if(!Array.isArray(data.list))throw new Error('历史记录结构异常');
 for(const item of data.list)if(recordHistory(item))count++;
 if(!data.list.length||data.has_more===false||!data.cursor?.max){setKV('history_success',String(now()));baselineIfReady();return '已核对 '+count+' 条云端历史'}
 const next=JSON.stringify(data.cursor);if(visited.has(next))throw new Error('历史游标重复，本轮未标记为完整同步');visited.add(next);cursor=data.cursor;
 }
 throw new Error('历史分页达到保护上限，本轮未标记为完整同步');
}
export async function syncSeasons(client:BiliClient){
 const nav=await client.nav();setKV('account_name',nav.uname);setKV('account_face',nav.face||'');setKV('account_state','connected');
 const candidates:Collected[]=[];let complete=false;
 for(let pn=1;pn<=200;pn++){
 const data=await client.collected(pn,nav.mid);if(!Array.isArray(data.list))throw new Error('订阅列表结构异常');
 candidates.push(...data.list);
 if(!data.list.length||data.has_more===false||candidates.length>=data.count){complete=true;break}
 }
 if(!complete)throw new Error('订阅列表超过分页上限');
 const active:string[]=[];let videos=0,failed=0;
 for(const candidate of candidates){
 reportProgress('发现/导入合集，已收录 '+videos+' 个视频',active.length,candidates.length);
 const id=String(candidate.season_id||candidate.id),mid=String(candidate.mid||candidate.upper?.mid||'');
 if(!id||!mid){failed++;continue}
 const known=db().prepare('SELECT id FROM seasons WHERE id=?').get(id);
 if(known&&!seasonSelected(id)){active.push(id);db().prepare('UPDATE seasons SET active=1 WHERE id=?').run(id);continue}
 let first;
 try{first=await client.season(mid,id,1)}catch(e){if(e instanceof BiliError&&[-400,-404,62002].includes(e.code))continue;throw e}
 if(!Array.isArray(first.archives)||!first.meta?.season_id)throw new Error('合集响应结构异常，未清理原记录');
 active.push(id);
 if(!db().prepare('SELECT id FROM seasons WHERE id=?').get(id))selectNewSeason(id);
 db().prepare(`INSERT INTO seasons(id,mid,title,cover,author) VALUES(?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET title=excluded.title,cover=excluded.cover,author=excluded.author,active=1`).run(id,mid,first.meta.name||candidate.title,first.meta.cover||'',candidate.upper?.name||'');
 if(!seasonSelected(id))continue;
 const members:string[]=[];let seasonComplete=false,skipped=false;
 for(let pn=1;pn<=500;pn++){
 const data=pn===1?first:await client.season(mid,id,pn);
 if(!Array.isArray(data.archives))throw new Error('合集分页结构异常');
 if(!seasonSelected(id)){skipped=true;break}
 for(const arc of data.archives){
 if(!arc.bvid)continue;
 db().prepare(`INSERT INTO videos(bvid,title,cover,author,duration,published_at,discovered_at) VALUES(?,?,?,?,?,?,?) ON CONFLICT(bvid) DO UPDATE SET title=excluded.title,cover=excluded.cover,author=CASE WHEN videos.author='' THEN excluded.author ELSE videos.author END,published_at=excluded.published_at`).run(arc.bvid,arc.title,arc.pic||'',candidate.upper?.name||'',arc.duration||0,arc.pubdate||0,now());
 const position=members.length;members.push(arc.bvid);
 db().prepare('INSERT INTO season_videos(season_id,bvid,position) VALUES(?,?,?) ON CONFLICT(season_id,bvid) DO UPDATE SET position=excluded.position').run(id,arc.bvid,position);
 videos++;
 }
 if(!data.archives.length||pn*30>=data.page.total){seasonComplete=true;break}
 }
 if(skipped)continue;
 if(!seasonComplete)throw new Error('合集超过分页上限');
 transaction(()=>{const set=new Set(members);for(const row of db().prepare('SELECT bvid FROM season_videos WHERE season_id=?').all(id))if(!set.has(String(row.bvid)))db().prepare('DELETE FROM season_videos WHERE season_id=? AND bvid=?').run(id,String(row.bvid));db().prepare('UPDATE seasons SET synced_at=? WHERE id=?').run(now(),id)});
 }
 if(failed===0){transaction(()=>{const set=new Set(active);for(const row of db().prepare('SELECT id FROM seasons').all())if(!set.has(String(row.id)))db().prepare('UPDATE seasons SET active=0 WHERE id=?').run(String(row.id))});setKV('seasons_success',String(now()));baselineIfReady()}
 if(pendingDetails().length)enqueue('details');
 return '已同步 '+active.length+' 个合集、'+videos+' 个视频'+(failed?'；'+failed+' 项信息未取全，保留原记录':'');
}

export async function syncHistorySearch(client:BiliClient,{requestBudget=10}={}){
 const nav=await client.nav();setKV('account_name',nav.uname);setKV('account_face',nav.face||'');setKV('account_state','connected');
 const videos=db().prepare('SELECT DISTINCT v.bvid,v.title,v.author FROM videos v JOIN season_videos sv ON sv.bvid=v.bvid JOIN seasons s ON s.id=sv.season_id WHERE s.active=1').all().filter(v=>db().prepare('SELECT season_id FROM season_videos WHERE bvid=?').all(String(v.bvid)).some(row=>seasonSelected(String(row.season_id))));
 const groups=new Map<string,string[]>();
 for(const video of videos){const keyword=String(video.author||video.title).trim();if(keyword)groups.set(keyword,[...(groups.get(keyword)||[]),String(video.bvid)])}
 let matched=0,requests=0,complete=0;
 for(const [keyword,ids] of groups){
  const key='history_search_'+createHash('sha256').update(keyword).digest('hex');
  const signature=ids.sort().join(',');
  let state=JSON.parse(getKV(key,'null')) as {signature:string;pn:number;updatedAt:number;previous:string}|null;
  if(!state||state.signature!==signature)state={signature,pn:1,updatedAt:0,previous:''};
  if(state.updatedAt&&now()-state.updatedAt<86400){complete++;continue}
  const targets=new Set(ids);
  while(requests<requestBudget){
   reportProgress('匹配观看历史',complete,groups.size);
   const data=await client.searchHistory(keyword,state.pn);requests++;
   if(!Array.isArray(data.list))throw new Error('历史搜索响应结构异常，保留原进度和断点');
   const fingerprint=createHash('sha256').update(JSON.stringify(data.list)).digest('hex');
   if(data.list.length&&state.previous===fingerprint)throw new Error('历史搜索分页重复，保留原进度和断点');
   const finished:boolean=!data.list.length||data.has_more===false||(!!data.page&&state.pn*(data.page.size||30)>=data.page.total);
   for(const item of data.list)if(targets.has(item.history?.bvid||item.bvid)&&recordHistory(item))matched++;
   state={signature,pn:finished?1:state.pn+1,updatedAt:finished?now():0,previous:finished?'':fingerprint};
   setKV(key,JSON.stringify(state));
   if(finished){complete++;break}
  }
  if(requests>=requestBudget)break;
 }
 return '历史搜索本轮 '+requests+' 次请求，匹配 '+matched+' 条记录；已核对 '+complete+'/'+groups.size+' 组'+(complete===groups.size?'，本轮核对完成':'，剩余下轮从断点继续');
}

export async function syncRecentHistory(client:BiliClient){
 const saved=JSON.parse(getKV('recent_history_cursor','null')) as {cursor:{max:number;view_at:number;business:string};cutoff:number;newest:number}|null;
 let cursor=saved?.cursor||{max:0,view_at:0,business:''};
 const cutoff=saved?.cutoff||Number(getKV('recent_history_watermark','0'));
 let newest=saved?.newest||cutoff,count=0;const seen=new Set<string>();
 for(let page=0;page<5;page++){
  reportProgress('同步最近历史第 '+(page+1)+' 页，已读 '+count+' 条',page,5);
  const data=await client.history(cursor);if(!Array.isArray(data.list))throw new Error('最近历史响应结构异常');
  for(const item of data.list){if(recordHistory(item))count++;newest=Math.max(newest,item.view_at||0)}
  const reached=cutoff>0&&data.list.some(item=>item.view_at<cutoff-120);
  if(reached||!data.list.length||data.has_more===false||!data.cursor?.max){setKV('recent_history_watermark',String(newest));setKV('recent_history_cursor','null');return '已核对 '+count+' 条最近历史'}
  const next=JSON.stringify(data.cursor);if(seen.has(next)||next===JSON.stringify(cursor))throw new Error('最近历史游标重复');seen.add(next);cursor=data.cursor;
  setKV('recent_history_cursor',JSON.stringify({cursor,cutoff,newest}));
 }
 return '最近历史已保存 '+count+' 条，下轮续传';
}

export async function syncDetails(client:BiliClient,{limit=10}={}){
 let completed=0;
 const pending=pendingDetails();
 for(const bvid of pending.slice(0,limit)){
  reportProgress('补齐分 P 和章节（本批）',completed,Math.min(limit,pending.length));
  try{upsertDetail(await client.detail(bvid));db().prepare('INSERT OR REPLACE INTO detail_attempts(bvid,attempted_at) VALUES(?,?)').run(bvid,now());completed++}catch(e){if(e instanceof BiliError&&[-404,62002,62012].includes(e.code)){db().prepare('INSERT OR REPLACE INTO detail_attempts(bvid,attempted_at) VALUES(?,?)').run(bvid,now());continue}throw e}
 }
 return '已补齐 '+completed+' 个视频的分 P /章节，剩余 '+pendingDetails().length+' 个';
}
export function startLikesScan(){
 const old=JSON.parse(getKV('likes_scan','null'));if(old?.status==='scanning')return old;
 const scan={status:'scanning',ids:selectedVideoIds(),matched:[] as string[],index:0,startedAt:now()};
 if(!scan.ids.length)scan.status='ready';setKV('likes_scan',JSON.stringify(scan));return scan;
}
export async function scanLikes(client:BiliClient,{limit=10}={}){
 const scan=JSON.parse(getKV('likes_scan','null')) as ReturnType<typeof startLikesScan>|null;
 if(!scan||scan.status!=='scanning')return '没有待核对的点赞任务';
 for(let i=0;i<limit&&scan.index<scan.ids.length;i++){
  // Persist only after a successful response; failures retry the same video.
  reportProgress('核对点赞，已匹配 '+scan.matched.length+' 个',scan.index,scan.ids.length);
  const liked=await client.hasLiked(scan.ids[scan.index]);
  if(JSON.parse(getKV('likes_scan','null'))?.status!=='scanning')return '点赞核对已取消';
  if(liked)scan.matched.push(scan.ids[scan.index]);scan.index++;
  if(scan.index===scan.ids.length)scan.status='ready';setKV('likes_scan',JSON.stringify(scan));
 }
 return '点赞核对 '+scan.index+'/'+scan.ids.length+'，匹配 '+scan.matched.length+' 个；'+(scan.status==='ready'?'等待确认应用':'下批继续');
}
