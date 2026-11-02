import type {VideoSort} from './video-sort.ts';
export type View='home'|'queue'|'seasons'|'recent'|'settings'|'detail';
export interface RouteState{view:View;seasonId:string;sectionId:string;filter:string;search:string;sort:VideoSort;page:number;queueSeason:string;scope:'synced'|'all';video:string}
export function readRoute(search:string,pathname='/'):RouteState{
 const p=new URLSearchParams(search),views=['home','queue','seasons','recent','settings','detail'];
 const legacyView=(views.includes(p.get('view')||'')?p.get('view'):'home') as View;
 const path=pathname.replace(/\/$/,'')||'/';
 const paths:Record<string,View>={'/':'home','/queue':'queue','/collections':'seasons','/recent':'recent','/settings':'settings'};
 const detail=path.match(/^\/collections\/([^/]+)$/);let seasonId='';
 try{seasonId=detail?decodeURIComponent(detail[1]):path==='/'?(p.get('season')||''):''}catch{}
 const view:View=detail?(seasonId?'detail':'seasons'):path==='/'?legacyView:(paths[path]||'home');
 const filters=['pending','all','unwatched','watching','completed','ignored'];
 const sorts=['published_desc','published_asc','discovered_desc','title_asc','collection'];
 const page=Number(p.get('page')||1);
 return {view,seasonId,sectionId:p.get('section')||'all',filter:filters.includes(p.get('status')||'')?p.get('status')!:(view==='detail'?'all':'pending'),search:p.get('q')||'',sort:(sorts.includes(p.get('sort')||'')?p.get('sort'):'published_desc') as VideoSort,page:Number.isSafeInteger(page)&&page>0?page:1,queueSeason:p.get('collection')||'all',scope:p.get('scope')==='all'?'all':'synced',video:p.get('video')||''};
}
export function routeSearch(route:RouteState){
 const p=new URLSearchParams();
 if(route.filter!==(route.view==='detail'?'all':'pending'))p.set('status',route.filter);
 if(route.sectionId!=='all')p.set('section',route.sectionId);
 if(route.search)p.set('q',route.search);
 if(route.sort!=='published_desc')p.set('sort',route.sort);
 if(route.queueSeason!=='all')p.set('collection',route.queueSeason);
 if(route.scope!=='synced')p.set('scope',route.scope);
 if(route.page>1)p.set('page',String(route.page));
 if(route.video)p.set('video',route.video);
 return p.size?'?'+p.toString():'';
}

export function routeHref(route:RouteState){
 const paths:Record<View,string>={home:'/',queue:'/queue',seasons:'/collections',recent:'/recent',settings:'/settings',detail:route.seasonId?'/collections/'+encodeURIComponent(route.seasonId):'/collections'};
 return paths[route.view]+routeSearch(route);
}
