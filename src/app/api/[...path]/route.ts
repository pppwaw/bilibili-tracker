import {randomUUID} from 'node:crypto';
import QRCode from 'qrcode';
import {HttpError,requireAuth,checkOrigin,login,revoke,sessionCookie,body} from '@/lib/auth';
import {db,getKV,setKV,settings,enqueue,setOverride,dashboard,now,transaction,setOverrides,selectedVideoIds} from '@/lib/db';
import {BiliClient,BiliError,sanitizeCookie} from '@/lib/bilibili';
import {startLikesScan} from '@/lib/sync';
import {encrypt,decrypt} from '@/lib/crypto';
import type {Override} from '@/lib/types';
export const runtime='nodejs';
export const dynamic='force-dynamic';
function json(data:unknown,status=200,headers:Record<string,string>={}){return Response.json(data,{status,headers:{'Cache-Control':'no-store',...headers}})}
async function bind(cookie:string){
 const nav=await new BiliClient(cookie).nav(),previous=getKV('account_mid');
 if(previous&&previous!==String(nav.mid))throw new HttpError(409,'当前数据库已绑定另一账号，请使用独立数据目录');
 transaction(()=>{setKV('credential',encrypt(cookie));setKV('account_mid',String(nav.mid));setKV('account_name',nav.uname);setKV('account_face',nav.face||'');setKV('account_state','connected');setKV('cooldown_until','0');setKV('failures','0')});
 enqueue('seasons');enqueue('history');return nav.uname;
}
async function handle(request:Request,context:{params:Promise<{path:string[]}>}){
 try{
 const {path}=await context.params,key=path.join('/'),method=request.method;
 if(method!=='GET')checkOrigin(request);
 if(key==='auth/login'&&method==='POST'){const b=await body(request);if(typeof b.password!=='string')throw new HttpError(400,'请输入密码');const token=login(b.password);if(!token)throw new HttpError(401,'密码不正确');return json({ok:true},200,{'Set-Cookie':sessionCookie(token)})}
 requireAuth(request);
 if(key==='auth/logout'&&method==='POST'){revoke(request);return json({ok:true},200,{'Set-Cookie':sessionCookie('',true)})}
 if(key==='dashboard'&&method==='GET')return json(dashboard());
 if(key==='sync'&&method==='POST'){const b=await body(request);if(!['history','seasons','all'].includes(String(b.kind)))throw new HttpError(400,'同步类型无效');if(!getKV('credential'))throw new HttpError(409,'请先绑定 B 站账号');if(getKV('account_state')==='expired')throw new HttpError(409,'请重新绑定 B 站账号');const ids=[];if(b.kind!=='history')ids.push(enqueue('seasons'));if(b.kind!=='seasons')ids.push(enqueue('history'));return json({ok:true,ids},202)}
 if(key==='seasons/default'&&method==='POST'){
 const b=await body(request);if(typeof b.enabled!=='boolean')throw new HttpError(400,'请选择新合集默认同步方式');
 setKV('new_season_default',String(b.enabled));return json({ok:true});
 }
 if(key==='seasons/selection' &&method==='POST'){
 const b=await body(request);
 if(!Array.isArray(b.ids)||b.ids.length>2000||!b.ids.every(id=>typeof id==='string'))throw new HttpError(400,'合集选择格式无效');
 const known=new Set(db().prepare('SELECT id FROM seasons WHERE active=1').all().map(s=>String(s.id)));
 if(!b.ids.every(id=>known.has(String(id))))throw new HttpError(400,'合集不存在，请刷新列表');
 setKV('selected_seasons',JSON.stringify([...new Set(b.ids)]));enqueue('seasons');enqueue('history');return json({ok:true});
 }
 if(key==='settings' &&method==='POST'){
 const b=await body(request),cfg={threshold:Number(b.threshold),historyMinutes:Number(b.historyMinutes),seasonMinutes:Number(b.seasonMinutes)};
 if(!Number.isFinite(cfg.threshold)||cfg.threshold<50||cfg.threshold>100||![cfg.historyMinutes,cfg.seasonMinutes].every(x=>Number.isInteger(x)&&x>=5&&x<=1440))throw new HttpError(400,'完成阈值需为 50–100%，同步间隔需为 5–1440 分钟');
 setKV('settings',JSON.stringify(cfg));return json({ok:true,settings:settings()});
 }
 if(key==='videos/batch'&&method==='POST'){
 const b=await body(request,1024*1024);try{return json({ok:true,count:setOverrides(b.ids as string[],b.state as Override)})}catch(e){throw new HttpError(400,e instanceof Error?e.message:'批量修改失败')}
 }
 if(key==='likes/scan'&&method==='POST'){
 if(!getKV('credential'))throw new HttpError(409,'请先绑定 B 站账号');const scan=startLikesScan();if(scan.status==='scanning')enqueue('likes');return json({ok:true},202);
 }
 if(key==='likes/cancel'&&method==='POST'){const scan=JSON.parse(getKV('likes_scan','null'));if(scan)setKV('likes_scan',JSON.stringify({...scan,status:'cancelled'}));return json({ok:true})}
 if(key==='likes/apply'&&method==='POST'){
 const b=await body(request),scan=JSON.parse(getKV('likes_scan','null'));
 if(!scan||scan.status!=='ready'||b.startedAt!==scan.startedAt)throw new HttpError(409,'请等待完整核对后重新确认');
 const active=new Set(selectedVideoIds()),ids=scan.matched.filter((id:string)=>active.has(id));
 const count=ids.length?setOverrides(ids,'completed'):0;setKV('likes_scan',JSON.stringify({...scan,status:'applied'}));return json({ok:true,count});
 }
 if(key==='videos/state' &&method==='POST'){const b=await body(request);if(![null,'unwatched','watching','completed','ignored'].includes(b.state as null|string))throw new HttpError(400,'观看状态无效');if(typeof b.bvid!=='string'||!setOverride(b.bvid,b.state as Override))throw new HttpError(404,'视频不存在');return json({ok:true})}
 if(key==='bilibili/cookie'&&method==='POST'){const b=await body(request);if(typeof b.cookie!=='string')throw new HttpError(400,'请填写登录凭据');let cookie;try{cookie=sanitizeCookie(b.cookie)}catch{throw new HttpError(400,'Cookie 格式无效，需要包含 SESSDATA')}return json({ok:true,name:await bind(cookie)})}
 if(key==='bilibili/disconnect'&&method==='POST'){setKV('credential','');setKV('account_state','disconnected');db().prepare("UPDATE jobs SET status='cancelled',finished_at=?,message='账号已解除绑定' WHERE status='pending'").run(now());return json({ok:true})}
 if(key==='bilibili/qr'&&method==='POST'){
 if(now()-Number(getKV('last_qr','0'))<5)throw new HttpError(429,'请稍后再生成二维码');
 setKV('last_qr',String(now()));const qr=await new BiliClient().qrGenerate();
 if(!qr.url.startsWith('https://'))throw new HttpError(502,'二维码响应异常');
 const id=randomUUID();db().prepare('INSERT INTO qr_requests(id,qr_key,expires_at) VALUES(?,?,?)').run(id,encrypt(qr.qrcode_key),now()+180);
 return json({id,image:await QRCode.toDataURL(qr.url,{width:240,margin:2}),expiresAt:now()+180});
 }
 if(key==='bilibili/qr/poll'&&method==='POST'){
 const b=await body(request);if(typeof b.id!=='string')throw new HttpError(400,'二维码无效');
 const qr=db().prepare('SELECT * FROM qr_requests WHERE id=? AND expires_at>?').get(b.id,now());if(!qr)return json({state:'expired'});
 const pollKey='qr_poll_'+b.id;if(now()-Number(getKV(pollKey,'0'))<2)throw new HttpError(429,'请稍后重试');setKV(pollKey,String(now()));
 const result=await new BiliClient().qrPoll(decrypt(String(qr.qr_key))),code=result.data.code;
 if(code===0){const cookie=sanitizeCookie(result.cookies.map(s=>s.split(';')[0]).join('; '));await bind(cookie);db().prepare('DELETE FROM qr_requests WHERE id=?').run(b.id);db().prepare('DELETE FROM kv WHERE key=?').run(pollKey);return json({state:'connected'})}
 return json({state:code===86038?'expired':code===86090?'confirm':'waiting'});
 }
 throw new HttpError(404,'接口不存在');
 }catch(e){if(e instanceof HttpError)return json({error:e.message},e.status);if(e instanceof BiliError)return json({error:e.message},502);console.error('API operation failed:',e instanceof Error?e.name:'unknown');return json({error:'操作失败，请检查服务器配置或稍后重试'},500)}
}
export const GET=handle;export const POST=handle;
