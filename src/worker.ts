import {setTimeout as delay} from 'node:timers/promises';
import {randomUUID} from 'node:crypto';
import {db,getKV,setKV,settings,enqueue,transaction,now,pendingDetails,reportProgress} from './lib/db.ts';
import {credentialClient,syncHistorySearch,syncSeasons,syncRecentHistory,syncDetails,scanLikes} from './lib/sync.ts';
import {BiliError} from './lib/bilibili.ts';
const owner=randomUUID();let stopped=false;
function lease(){return transaction(()=>{const leaseOwner=getKV('worker_owner'),until=Number(getKV('worker_lease','0'));if(leaseOwner&&leaseOwner!==owner&&until>now())return false;setKV('worker_owner',owner);setKV('worker_lease',String(now()+90));setKV('worker_heartbeat',String(now()));return true})}
if(!lease())throw new Error('另一个 Worker 正在运行');
db().prepare("UPDATE jobs SET status='failed',finished_at=?,message='Worker 上次意外停止，可重新同步' WHERE status='running'").run(now());
const heartbeat=setInterval(()=>{if(!lease()){stopped=true;console.error('Worker lease lost')}},15000);
process.on('SIGTERM',()=>{stopped=true});process.on('SIGINT',()=>{stopped=true});
console.log('Bilibili Tracker Worker started');
try{
 while(!stopped){
 if(!getKV('credential')||getKV('account_state')==='expired'||Number(getKV('cooldown_until','0'))>now()){await delay(2000);continue}
 const cfg=settings();
 for(const [kind,minutes] of [['seasons',cfg.seasonMinutes],['history',cfg.historyMinutes]] as const){
 if(now()-Number(getKV(kind+'_attempt','0'))>=minutes*60)enqueue(kind);
 }
 if(pendingDetails().length&&now()-Number(getKV('details_attempt','0'))>=30)enqueue('details');
 if(JSON.parse(getKV('likes_scan','null'))?.status==='scanning')enqueue('likes');
 const job=transaction(()=>{const row=db().prepare("SELECT * FROM jobs WHERE status='pending' ORDER BY id LIMIT 1").get();if(row)db().prepare("UPDATE jobs SET status='running',started_at=? WHERE id=?").run(now(),Number(row.id));return row});
 if(!job){await delay(2000);continue}
 reportProgress('正在准备同步',0,0);
 const kind=String(job.kind);setKV(kind+'_attempt',String(now()));
 try{
 const client=credentialClient(),message=kind==='history'?(await syncRecentHistory(client))+'；'+(await syncHistorySearch(client)):kind==='details'?await syncDetails(client):kind==='likes'?await scanLikes(client):await syncSeasons(client);
 db().prepare("UPDATE jobs SET status='success',finished_at=?,message=? WHERE id=?").run(now(),message,Number(job.id));
 setKV('failures','0');setKV('worker_progress','null');
 }catch(e){
 setKV('worker_progress','null');
 const failure=Number(getKV('failures','0'))+1;setKV('failures',String(failure));
 const limited=e instanceof BiliError&&[-352,-412,-509].includes(e.code);
 setKV('cooldown_until',String(now()+(limited?Math.min(21600,1800*2**Math.min(failure-1,3)):Math.min(3600,60*2**Math.min(failure,6)))));
 if(e instanceof BiliError&&e.code===-101)setKV('account_state','expired');
 const message=e instanceof Error?e.message:'同步失败';
 db().prepare("UPDATE jobs SET status='failed',finished_at=?,message=? WHERE id=?").run(now(),message,Number(job.id));
 console.error('Sync failed:',kind,message);
 }
 db().prepare('DELETE FROM sessions WHERE expires_at<?').run(now());
 db().prepare('DELETE FROM qr_requests WHERE expires_at<?').run(now());
 }
}finally{clearInterval(heartbeat);transaction(()=>{if(getKV('worker_owner')===owner){setKV('worker_owner','');setKV('worker_lease','0')}})}
