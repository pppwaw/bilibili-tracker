import {createHash,randomBytes,timingSafeEqual} from 'node:crypto';
import {db,now,transaction} from './db.ts';
export class HttpError extends Error{status:number;constructor(status:number,message:string){super(message);this.status=status}}
function password(){const value=process.env.APP_PASSWORD||'';if(value.length<12)throw new HttpError(503,'请在服务器设置至少 12 位的 APP_PASSWORD');return value}
export function configReady(){password();if(!/^[a-f\d]{64}$/i.test(process.env.ENCRYPTION_KEY||''))throw new HttpError(503,'请在服务器配置 ENCRYPTION_KEY');if(!process.env.APP_ORIGIN)throw new HttpError(503,'请在服务器配置 APP_ORIGIN')}
const digest=(s:string)=>createHash('sha256').update(s).digest();
function sessionHash(token:string){return digest(password()+':'+token).toString('hex')}
export function checkOrigin(request:Request){const origin=request.headers.get('origin');if(origin!==new URL(process.env.APP_ORIGIN||'http://localhost:3000').origin)throw new HttpError(403,'请求来源不匹配')}
export function authenticated(request:Request){configReady();const token=request.headers.get('cookie')?.split(';').map(s=>s.trim()).find(s=>s.startsWith('bili_session='))?.slice(13);if(!token||!/^[a-f\d]{64}$/.test(token))return false;return !!db().prepare('SELECT token_hash FROM sessions WHERE token_hash=? AND expires_at>?').get(sessionHash(token),now())}
export function requireAuth(request:Request){if(!authenticated(request))throw new HttpError(401,'请先登录')}
export function login(value:string){
 configReady();
 return transaction(()=>{
 const attempts=db().prepare('SELECT * FROM login_attempts WHERE id=1').get();
 if(attempts&&now()-Number(attempts.window_at)<900&&Number(attempts.failures)>=10)throw new HttpError(429,'尝试过多，请 15 分钟后重试');
 const correct=timingSafeEqual(digest(value),digest(password()));
 if(!correct){
 if(!attempts||now()-Number(attempts.window_at)>=900)db().prepare('INSERT OR REPLACE INTO login_attempts(id,failures,window_at) VALUES(1,1,?)').run(now());
 else db().prepare('UPDATE login_attempts SET failures=failures+1 WHERE id=1').run();
 return null;
 }
 db().prepare('DELETE FROM login_attempts').run();
 const token=randomBytes(32).toString('hex');db().prepare('INSERT INTO sessions(token_hash,expires_at) VALUES(?,?)').run(sessionHash(token),now()+7*86400);return token;
 });
}
export function revoke(request:Request){const token=request.headers.get('cookie')?.split(';').map(s=>s.trim()).find(s=>s.startsWith('bili_session='))?.slice(13);if(token)db().prepare('DELETE FROM sessions WHERE token_hash=?').run(sessionHash(token))}
export function sessionCookie(token:string,remove=false){const secure=new URL(process.env.APP_ORIGIN||'http://localhost:3000').protocol==='https:';return 'bili_session='+token+'; Path=/; HttpOnly; SameSite=Strict; Max-Age='+(remove?0:604800)+(secure?'; Secure':'')}
export async function body(request:Request,maxBytes=16384):Promise<Record<string,unknown>>{if(!request.headers.get('content-type')?.startsWith('application/json'))throw new HttpError(415,'需要 JSON 请求');const reader=request.body?.getReader();if(!reader)throw new HttpError(400,'请求为空');const chunks:Uint8Array[]=[];let size=0;while(true){const chunk=await reader.read();if(chunk.done)break;size+=chunk.value.length;if(size>maxBytes){await reader.cancel();throw new HttpError(413,'请求过大')}chunks.push(chunk.value)}try{const result=JSON.parse(Buffer.concat(chunks).toString('utf8'));if(!result||typeof result!=='object'||Array.isArray(result))throw new Error();return result}catch{throw new HttpError(400,'JSON 格式错误')}}
