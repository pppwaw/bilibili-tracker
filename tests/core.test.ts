import {readRoute,routeSearch,routeHref} from '../src/lib/route-state.ts';
import {sortVideos} from '../src/lib/video-sort.ts';
import {coverUrl} from '../src/lib/image-url.ts';
import {test,after} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {calculateStatus} from '../src/lib/progress.ts';
import {db,dashboard,setKV,getKV,enqueue,setOverride,settings,now,selectNewSeason,setOverrides,pendingDetails} from '../src/lib/db.ts';
import {recordHistory,upsertDetail,syncHistory,syncSeasons,syncHistorySearch,syncRecentHistory,syncDetails,startLikesScan,scanLikes} from '../src/lib/sync.ts';
import {encrypt,decrypt} from '../src/lib/crypto.ts';
import {login,authenticated,checkOrigin,HttpError,revoke,sessionCookie} from '../src/lib/auth.ts';
import {BiliClient,BiliError,sanitizeCookie} from '../src/lib/bilibili.ts';
import type {PageProgress} from '../src/lib/types.ts';
import type {BiliHistory,VideoDetail} from '../src/lib/bilibili.ts';
const root=mkdtempSync(join(tmpdir(),'bili-test-'));
process.env.DATABASE_PATH=join(root,'bili.db');
process.env.ENCRYPTION_KEY='a'.repeat(64);
process.env.APP_PASSWORD='test-password-very-long';
process.env.APP_ORIGIN='https://bili.example.com';
after(()=>{db().close();rmSync(root,{recursive:true,force:true})});
const page=(overrides:Partial<PageProgress>={}):PageProgress=>({cid:'1',page:1,title:'P1',duration:100,progress:null,completed:0,...overrides});
const detail=(bvid='BVtest'):VideoDetail=>({bvid,title:'测试课程',pic:'',duration:200,pubdate:100,owner:{name:'测试UP'},pages:[{cid:1,page:1,part:'P1',duration:100},{cid:2,page:2,part:'P2',duration:100}]});
const history=(progress:number,cid=1,viewAt=1000,bvid='BVtest'):BiliHistory=>({bvid,title:'测试课程',cover:'',author_name:'测试UP',view_at:viewAt,progress,duration:100,history:{business:'archive',cid,page:cid}});
test('missing history is unwatched regardless of baseline',()=>{assert.equal(calculateStatus([page()],95,100,200).status,'unwatched');assert.equal(calculateStatus([page()],95,300,200).status,'unwatched');assert.equal(calculateStatus([],95,100,0).status,'unwatched')});
test('opening at zero is watching, not completed',()=>{assert.equal(calculateStatus([page({progress:0})],95,0,0).status,'watching')});
test('jumping to last P never completes unseen preceding P',()=>{assert.equal(calculateStatus([page(),page({cid:'2',page:2,completed:1})],95,0,0).status,'watching')});
test('completion threshold applies to every P; override wins',()=>{assert.equal(calculateStatus([page({progress:95}),page({cid:'2',progress:94})],95,0,0).status,'watching');assert.equal(calculateStatus([page({progress:95})],95,0,0).status,'completed');assert.equal(calculateStatus([page()],95,0,0,'completed').progress,100)});
test('credentials encrypt, decrypt and reject tampering',()=>{const value=encrypt('SESSDATA=secret');assert.ok(!value.includes('secret'));assert.equal(decrypt(value),'SESSDATA=secret');const buf=Buffer.from(value,'base64');buf[buf.length-1]^=1;assert.throws(()=>decrypt(buf.toString('base64')))});
test('cookie parser keeps only allowed cookies and prevents header injection',()=>{assert.equal(sanitizeCookie('SESSDATA=abc; other=secret; bili_jct=xyz'),'SESSDATA=abc; bili_jct=xyz');assert.equal(sanitizeCookie('abc'),'SESSDATA=abc');assert.throws(()=>sanitizeCookie('SESSDATA=abc\r\ninjected'));assert.throws(()=>sanitizeCookie('other=bad'))});
test('persistent history before collection import is replayed per CID',()=>{
 recordHistory(history(97));upsertDetail(detail());
 const v=dashboard().videos.find(v=>v.bvid==='BVtest')!;assert.equal(v.pages[0].progress,97);assert.equal(v.pages[1].progress,null);assert.equal(v.status,'watching');
});
test('same history timestamp updates progress; replay never lowers max or completion',()=>{
 recordHistory(history(99));recordHistory(history(-1,2));recordHistory(history(5,2,2000));recordHistory(history(3,1,2000));
 let v=dashboard().videos.find(v=>v.bvid==='BVtest')!;assert.equal(v.status,'completed');assert.equal(v.pages[0].progress,99);assert.equal(v.pages[1].completed,1);
 upsertDetail(detail());v=dashboard().videos.find(v=>v.bvid==='BVtest')!;assert.equal(v.status,'completed');
});
test('completion threshold can be raised without losing raw observations',()=>{
 setKV('settings',JSON.stringify({...settings(),threshold:100}));assert.equal(dashboard().videos[0].status,'watching');setKV('settings',JSON.stringify({...settings(),threshold:95}));assert.equal(dashboard().videos[0].status,'completed');
});
test('manual override is durable and can return to auto',()=>{setOverride('BVtest','unwatched');assert.equal(dashboard().videos[0].status,'unwatched');setOverride('BVtest',null);assert.equal(dashboard().videos[0].status,'completed')});
test('duplicate pending/running tasks are coalesced',()=>{const a=enqueue('history'),b=enqueue('history');assert.equal(a,b);db().prepare("UPDATE jobs SET status='running' WHERE id=?").run(a);assert.equal(enqueue('history'),a);db().prepare("UPDATE jobs SET status='success' WHERE id=?").run(a);assert.notEqual(enqueue('history'),a)});
test('password failure persists; lockout works; token cannot bypass auth',()=>{
 assert.equal(login('wrong'),null);assert.equal(db().prepare('SELECT failures FROM login_attempts').get()?.failures,1);
 const token=login(process.env.APP_PASSWORD!)!;assert.ok(token);const req=new Request('https://bili.example.com/api/dashboard',{headers:{cookie:'bili_session='+token}});assert.ok(authenticated(req));assert.ok(!authenticated(new Request('https://bili.example.com')));assert.match(sessionCookie(token),/Secure/);revoke(req);assert.ok(!authenticated(req));
 for(let i=0;i<10;i++)login('wrong');assert.throws(()=>login('wrong'),(e:unknown)=>e instanceof HttpError&&e.status===429);db().prepare('DELETE FROM login_attempts').run();
});
test('CSRF rejects missing and external Origin',()=>{assert.throws(()=>checkOrigin(new Request('https://bili.example.com')));assert.throws(()=>checkOrigin(new Request('https://bili.example.com',{headers:{origin:'https://evil.example.com'}})));assert.doesNotThrow(()=>checkOrigin(new Request('https://bili.example.com',{headers:{origin:'https://bili.example.com'}})))});
test('full history pagination is required to establish success; repeated cursors fail',async()=>{
 const client=new BiliClient();client.nav=async()=>({isLogin:true,mid:1,uname:'tester'});client.history=async()=>({list:[history(10)],cursor:{max:1,view_at:1,business:'archive'}});
 setKV('history_success','');await assert.rejects(syncHistory(client),/游标重复/);assert.equal(getKV('history_success'),'');
 client.history=async()=>({list:[history(10)],cursor:{max:0,view_at:0,business:''}});await syncHistory(client);assert.ok(Number(getKV('history_success'))>0);
});
test('seasons paginate, exclude folders, and preserve state after failure',async()=>{
 const client=new BiliClient();client.nav=async()=>({isLogin:true,mid:1,uname:'tester'});client.collected=async()=>({list:[{id:10,mid:2,title:'合集'},{id:20,mid:2,title:'收藏夹'}],count:2,has_more:false});
 client.season=async(mid,id,pn)=>{if(id==='20')throw new BiliError(-404,'not season');return {archives:[{bvid:'BVtest',title:'课程',pic:'',duration:200,pubdate:100}],meta:{season_id:10,mid:2,name:'合集',cover:''},page:{total:1,page_num:pn,page_size:30}}};
 client.detail=async()=>detail();
 setKV('selected_seasons',JSON.stringify(['10']));await syncSeasons(client);assert.equal(dashboard().seasons.length,1);assert.equal(dashboard().seasons[0].active,1);assert.ok(Number(getKV('baseline'))>0);
 client.collected=async()=>{throw new BiliError(-352,'rate limited')};await assert.rejects(syncSeasons(client));assert.equal(dashboard().seasons[0].active,1);assert.equal(dashboard().videos[0].status,'completed');
});
test('storage snapshot survives a separate connection',async()=>{const {DatabaseSync}=await import('node:sqlite');const other=new DatabaseSync(process.env.DATABASE_PATH!);assert.ok(other.prepare('SELECT bvid FROM videos').get());other.close()});

test('search uses exact nested BV, preserves prior progress and unseen parts on empty results or failure',async()=>{
 const client=new BiliClient();client.nav=async()=>({isLogin:true,mid:1,uname:'tester'});
 upsertDetail(detail('BVsearch'));db().prepare('INSERT INTO season_videos(season_id,bvid,position) VALUES(?,?,?)').run('10','BVsearch',1);
 const item=history(40,1,3000,'');item.history.bvid='BVsearch';
 client.searchHistory=async()=>({list:[item,history(-1,2,3000,'BVunrelated')],has_more:false});
 await syncHistorySearch(client);let v=dashboard().videos.find(v=>v.bvid==='BVsearch')!;
 assert.equal(v.pages[0].progress,40);assert.equal(v.pages[1].progress,null);assert.equal(v.status,'watching');
 client.searchHistory=async()=>({list:[],has_more:false});await syncHistorySearch(client);
 assert.equal(dashboard().videos.find(v=>v.bvid==='BVsearch')!.pages[0].progress,40);
 db().prepare("DELETE FROM kv WHERE key LIKE 'history_search_%'").run();client.searchHistory=async()=>{throw new BiliError(-412,'blocked')};await assert.rejects(syncHistorySearch(client));
 assert.equal(dashboard().videos.find(v=>v.bvid==='BVsearch')!.pages[0].progress,40);
});

test('unselected collections stay discoverable but skip video import and history search',async()=>{
 setKV('selected_seasons','[]');const client=new BiliClient();client.nav=async()=>({isLogin:true,mid:1,uname:'tester'});
 client.collected=async()=>({list:[{id:30,mid:2,title:'excluded'}],count:1,has_more:false});
 client.season=async()=>({archives:[{bvid:'BVexcluded',title:'excluded',pic:'',duration:100,pubdate:100}],meta:{season_id:30,mid:2,name:'excluded',cover:''},page:{total:1,page_num:1,page_size:30}});
 client.detail=async()=>{throw new Error('must not import excluded videos')};
 await syncSeasons(client);assert.equal(dashboard().seasons.find(s=>s.id==='30')!.sync_enabled,false);assert.ok(!dashboard().videos.some(v=>v.bvid==='BVexcluded'));
 client.searchHistory=async()=>{throw new Error('must not search excluded videos')};await syncHistorySearch(client);
});

test('new collection default is opt-in and changing it preserves existing choices',()=>{
 setKV('selected_seasons','[]');setKV('new_season_default','false');selectNewSeason('new-off');assert.equal(getKV('selected_seasons'),'[]');
 setKV('new_season_default','true');selectNewSeason('new-on');selectNewSeason('new-on');assert.deepEqual(JSON.parse(getKV('selected_seasons')),['new-on']);
 setKV('new_season_default','false');selectNewSeason('later');assert.deepEqual(JSON.parse(getKV('selected_seasons')),['new-on']);
});

test('search groups by author, bounds requests, resumes failed page, and caches completed groups',async()=>{
 setKV('selected_seasons',JSON.stringify(['10']));db().prepare("UPDATE seasons SET active=1 WHERE id='10'").run();db().prepare("DELETE FROM kv WHERE key LIKE 'history_search_%'").run();
 const client=new BiliClient();client.nav=async()=>({isLogin:true,mid:1,uname:'tester'});const pages:number[]=[];
 client.searchHistory=async(keyword,pn)=>{pages.push(pn);return {list:[history(12,1,4000)],has_more:true}};
 await syncHistorySearch(client,{requestBudget:1});assert.deepEqual(pages,[1]);
 client.searchHistory=async(keyword,pn)=>{pages.push(pn);throw new BiliError(-412,'limited')};await assert.rejects(syncHistorySearch(client,{requestBudget:1}));assert.deepEqual(pages,[1,2]);
 client.searchHistory=async(keyword,pn)=>{pages.push(pn);return {list:[],has_more:false}};await syncHistorySearch(client,{requestBudget:1});assert.deepEqual(pages,[1,2,2]);
 await syncHistorySearch(client);assert.deepEqual(pages,[1,2,2]);
});
test('recent history persists nested BV progress and stops at overlap watermark',async()=>{
 setKV('recent_history_cursor','null');setKV('recent_history_watermark','3900');const client=new BiliClient();let calls=0;
 const item=history(65,1,4100,'');item.history.bvid='BVsearch';
 client.history=async()=>{calls++;return {list:[item,history(1,1,3500)],cursor:{max:99,view_at:3500,business:'archive'}}};
 await syncRecentHistory(client);assert.equal(calls,1);assert.equal(getKV('recent_history_watermark'),'4100');assert.equal(getKV('recent_history_cursor'),'null');
 assert.equal(dashboard().videos.find(v=>v.bvid==='BVsearch')!.pages[0].progress,65);
});

test('video covers normalize HTTP and protocol-relative Bilibili URLs to HTTPS',()=>{
 assert.equal(coverUrl('http://i2.hdslb.com/bfs/archive/cover.jpg'),'https://i2.hdslb.com/bfs/archive/cover.jpg');
 assert.equal(coverUrl('//archive.biliimg.com/cover.jpg'),'https://archive.biliimg.com/cover.jpg');
 assert.equal(coverUrl('https://i0.hdslb.com/cover.jpg'),'https://i0.hdslb.com/cover.jpg');
 for(const bad of ['http://hdslb.com.evil.example/cover.jpg','javascript:alert(1)','ftp://i0.hdslb.com/cover.jpg','https://user:pass@i0.hdslb.com/cover.jpg'])assert.equal(coverUrl(bad),'');
});

test('batch overrides deduplicate and roll back completely for missing videos',()=>{
 setOverride('BVtest',null);assert.equal(setOverrides(['BVtest','BVtest'],'ignored'),1);assert.equal(dashboard().videos.find(v=>v.bvid==='BVtest')!.override,'ignored');
 assert.throws(()=>setOverrides(['BVtest','missing'],'completed'));assert.equal(dashboard().videos.find(v=>v.bvid==='BVtest')!.override,'ignored');
 assert.equal(setOverrides(['BVtest'],null),1);assert.equal(dashboard().videos.find(v=>v.bvid==='BVtest')!.override,null);
});
test('collection listing never fetches per-video details and background details respect budget and section titles',async()=>{
 setKV('selected_seasons',JSON.stringify(['40']));const client=new BiliClient();client.nav=async()=>({isLogin:true,mid:1,uname:'tester'});
 client.collected=async()=>({list:[{id:40,mid:2,title:'课程',upper:{mid:2,name:'老师'}}],count:1,has_more:false});
 client.season=async()=>({archives:['BVfast1','BVfast2'].map(bvid=>({bvid,title:'课',pic:'',duration:200,pubdate:100})),meta:{season_id:40,mid:2,name:'课程',cover:''},page:{total:2,page_num:1,page_size:30}});
 client.detail=async()=>{throw new Error('list import must not wait for details')};await syncSeasons(client);
 assert.ok(dashboard().videos.find(v=>v.bvid==='BVfast1'));assert.equal(pendingDetails().length,2);
 client.detail=async bvid=>({...detail(bvid),ugc_season:{id:40,sections:[{id:1,title:'第一章',episodes:[{bvid:'BVfast1'}]},{id:2,title:'第二章',episodes:[{bvid:'BVfast2'}]}]}});
 await syncDetails(client,{limit:1});assert.equal(pendingDetails().length,1);assert.equal(dashboard().seasons.find(s=>s.id==='40')!.sections[1].title,'第二章');
 assert.deepEqual(dashboard().seasons.find(s=>s.id==='40')!.sections[0].videoIds,['BVfast1']);await syncDetails(client,{limit:1});assert.equal(pendingDetails().length,0);
});
test('likes scan is bounded, preserves state until apply, resumes same item on error and reports full preview',async()=>{
 setKV('likes_scan','null');setKV('selected_seasons',JSON.stringify(['40']));const client=new BiliClient();
 const scan=startLikesScan();assert.equal(scan.ids.length,2);client.hasLiked=async()=>true;
 await scanLikes(client,{limit:1});let current=JSON.parse(getKV('likes_scan'));assert.equal(current.index,1);assert.equal(current.status,'scanning');assert.equal(dashboard().videos.find(v=>v.bvid===scan.ids[0])!.override,null);
 client.hasLiked=async()=>{throw new BiliError(-412,'limited')};await assert.rejects(scanLikes(client));assert.equal(JSON.parse(getKV('likes_scan')).index,1);
 client.hasLiked=async()=>false;await scanLikes(client);current=JSON.parse(getKV('likes_scan'));assert.equal(current.status,'ready');assert.equal(current.matched.length,1);
 setOverrides(current.matched,'completed');assert.equal(dashboard().videos.find(v=>v.bvid===scan.ids[0])!.override,'completed');
});
test('cancelling likes during an upstream request does not overwrite cancellation',async()=>{
 setKV('likes_scan','null');startLikesScan();const client=new BiliClient();client.hasLiked=async()=>{const scan=JSON.parse(getKV('likes_scan'));setKV('likes_scan',JSON.stringify({...scan,status:'cancelled'}));return true};
 await scanLikes(client);const scan=JSON.parse(getKV('likes_scan'));assert.equal(scan.status,'cancelled');assert.equal(scan.index,0);assert.equal(scan.matched.length,0);
});

test('video date sorting defaults newest first, supports oldest first, and leaves unknown dates last',()=>{
 const rows=[{bvid:'old',title:'B',published_at:10,discovered_at:30},{bvid:'new',title:'A',published_at:20,discovered_at:10},{bvid:'unknown',title:'C',published_at:0,discovered_at:20}];
 assert.deepEqual(sortVideos(rows,'published_desc').map(v=>v.bvid),['new','old','unknown']);
 assert.deepEqual(sortVideos(rows,'published_asc').map(v=>v.bvid),['old','new','unknown']);
 assert.deepEqual(sortVideos(rows,'discovered_desc').map(v=>v.bvid),['old','unknown','new']);
 assert.deepEqual(sortVideos(rows,'title_asc').map(v=>v.bvid),['new','old','unknown']);
 assert.equal(rows[0].bvid,'old');
});

test('URL routes restore filters, ordering, page, collection and video without losing encoded text',()=>{
 const route={...readRoute(''),view:'detail' as const,seasonId:'42',filter:'all',search:'第一章 & B站',sort:'published_asc' as const,page:3,queueSeason:'12',scope:'all' as const,video:'BVtest'};
 const url=new URL(routeHref(route),'https://example.com');assert.deepEqual(readRoute(url.search,url.pathname),route);assert.equal(routeSearch(readRoute('')),'');
 const invalid=readRoute('?view=invalid&sort=bad&status=bad&page=-2');assert.equal(invalid.view,'home');assert.equal(invalid.page,1);assert.equal(invalid.sort,'published_desc');assert.equal(invalid.filter,'pending');
 assert.equal(readRoute('?view=detail&season=42').filter,'all');
});

test('clean page paths override legacy view parameters and old links canonicalize',()=>{
 for(const [view,path] of [['home','/'],['queue','/queue'],['seasons','/collections'],['recent','/recent'],['settings','/settings']] as const){const route=readRoute('',path);assert.equal(route.view,view);assert.equal(routeHref(route),path)}
 const old=readRoute('?view=detail&season=123&sort=published_asc&page=3');assert.equal(routeHref(old),'/collections/123?sort=published_asc&page=3');
 assert.equal(readRoute('?view=settings','/queue').view,'queue');assert.equal(readRoute('','/collections/123').seasonId,'123');
 assert.equal(readRoute('','/collections/%ZZ').view,'seasons');
});

test('series and chapter filters survive sharing and clean paths without changing collection identity',()=>{
 const list=readRoute('?collection=42&sort=published_asc&page=3','/recent');assert.equal(list.queueSeason,'42');assert.equal(routeHref(list),'/recent?sort=published_asc&collection=42&page=3');
 const detail=readRoute('?section=7&status=watching&page=2','/collections/42');assert.equal(detail.seasonId,'42');assert.equal(detail.sectionId,'7');assert.equal(detail.filter,'watching');
 const href=routeHref(detail),url=new URL(href,'https://example.com');assert.deepEqual(readRoute(url.search,url.pathname),detail);
 assert.equal(readRoute('','/collections/42').sectionId,'all');
});
