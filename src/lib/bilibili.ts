import {setTimeout as delay} from 'node:timers/promises';
export class BiliError extends Error {code:number;constructor(code:number,message:string){super(message);this.code=code;this.name='BiliError'}}
export interface BiliHistory {bvid:string;title:string;cover:string;author_name:string;view_at:number;progress:number;duration:number;history:{business:string;cid:number;page:number;bvid?:string}}
export interface Archive {bvid:string;title:string;pic:string;duration:number;pubdate:number}
export interface Collected {id:number;season_id?:number;mid:number;title:string;cover?:string;upper?:{mid:number;name:string}}
export interface SeasonPage {archives:Archive[];meta:{season_id:number;mid:number;name:string;cover:string};page:{total:number;page_num:number;page_size:number}}
export interface VideoDetail {bvid:string;title:string;pic:string;duration:number;pubdate:number;owner:{name:string};pages:{cid:number;page:number;part:string;duration:number}[];ugc_season?:{id:number;sections:{id:number;title:string;episodes:{bvid:string}[]}[]}}
export class BiliClient {
 cookie:string;lastRequest=0;
 constructor(cookie=''){this.cookie=cookie}
 async request<T>(path:string,params:Record<string,string|number>={},passport=false):Promise<{data:T;cookies:string[]}>{
 const url=new URL(path,passport?'https://passport.bilibili.com':'https://api.bilibili.com');for(const [k,v] of Object.entries(params))url.searchParams.set(k,String(v));
 for(let attempt=0;attempt<3;attempt++){
  await delay(Math.max(0,3000-(Date.now()-this.lastRequest)));this.lastRequest=Date.now();
  try{
   const res=await fetch(url,{headers:{'User-Agent':'Mozilla/5.0','Referer':'https://www.bilibili.com/',...(this.cookie?{Cookie:this.cookie}:{})},signal:AbortSignal.timeout(20000),redirect:'error',cache:'no-store'});
   if(res.status===429||res.status===412)throw new BiliError(-412,'B 站限制请求，稍后自动重试');
   if(!res.ok){if(res.status>=500)throw new Error('upstream');throw new BiliError(res.status,'B 站接口暂不可用')}
   const json=await res.json() as {code:number;data:T};
   if(json.code!==0){if(json.code===-101)throw new BiliError(-101,'B 站登录已失效，请重新登录');if([-352,-412,-509].includes(json.code))throw new BiliError(json.code,'B 站风控限制，已暂停本轮同步');throw new BiliError(json.code,'B 站接口返回错误（'+json.code+'）')}
   return {data:json.data,cookies:res.headers.getSetCookie()};
  }catch(error){if(error instanceof BiliError)throw error;if(attempt===2)throw new BiliError(-1,'无法连接 B 站或响应格式异常');await delay(2000*2**attempt)}
 }
 throw new BiliError(-1,'B 站请求失败');
 }
 async nav(){const {data}=await this.request<{isLogin:boolean;mid:number;uname:string;face?:string}>('/x/web-interface/nav');if(!data.isLogin)throw new BiliError(-101,'B 站登录已失效，请重新登录');return data}
 async collected(pn:number,mid:number){return (await this.request<{list:Collected[];count:number;has_more:boolean}>('/x/v3/fav/folder/collected/list',{up_mid:mid,pn,ps:20,platform:'web'})).data}
 async season(mid:string,id:string,pn:number){return (await this.request<SeasonPage>('/x/polymer/web-space/seasons_archives_list',{mid,season_id:id,page_num:pn,page_size:30,sort_reverse:'false'})).data}
 async detail(bvid:string){return (await this.request<VideoDetail>('/x/web-interface/view',{bvid})).data}
 async history(cursor:{max:number;view_at:number;business:string}){return (await this.request<{list:BiliHistory[];cursor:{max:number;view_at:number;business:string};has_more?:boolean}>('/x/web-interface/history/cursor',{...cursor,ps:30})).data}
 async searchHistory(keyword:string,pn:number){
 const {data}=await this.request<{list:BiliHistory[]|null;has_more?:boolean;page?:{total:number;size?:number}}>('/x/web-interface/history/search',{keyword,pn,ps:30,business:'archive'});
 if(data.list===null&&(data.has_more===false||data.page?.total===0))return {...data,list:[] as BiliHistory[]};
 return {...data,list:data.list as BiliHistory[]};
 }
 async hasLiked(bvid:string){const {data}=await this.request<number>('/x/web-interface/archive/has/like',{bvid});if(data!==0&&data!==1)throw new Error('点赞状态响应异常');return data===1}
 async qrGenerate(){return (await this.request<{url:string;qrcode_key:string}>('/x/passport-login/web/qrcode/generate',{},true)).data}
 async qrPoll(key:string){return this.request<{code:number;url:string;refresh_token?:string}>('/x/passport-login/web/qrcode/poll',{qrcode_key:key},true)}
}
export function sanitizeCookie(input:string):string{
 const allowed=new Set(['SESSDATA','bili_jct','DedeUserID','DedeUserID__ckMd5','sid','buvid3','buvid4']);
 const parts=input.includes('=')?input.split(';'):[`SESSDATA=${input}`],values=new Map<string,string>();
 for(const part of parts){const idx=part.indexOf('=');if(idx<0)continue;const name=part.slice(0,idx).trim(),value=part.slice(idx+1).trim();if(allowed.has(name)&&value&&!/[\r\n\s;]/.test(value))values.set(name,value)}
 if(!values.has('SESSDATA'))throw new Error('请填写有效的 SESSDATA 或 Cookie');
 return [...values].map(([k,v])=>k+'='+v).join('; ');
}
