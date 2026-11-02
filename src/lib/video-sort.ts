export type VideoSort='published_desc'|'published_asc'|'discovered_desc'|'title_asc'|'collection';
export function sortVideos<T extends {bvid:string;title:string;published_at:number;discovered_at:number}>(videos:T[],sort:Exclude<VideoSort,'collection'>):T[]{
 return [...videos].sort((a,b)=>{
  if(sort==='title_asc')return a.title.localeCompare(b.title,'zh-CN')||a.bvid.localeCompare(b.bvid);
  const field=sort==='discovered_desc'?'discovered_at':'published_at';
  const av=a[field]||0,bv=b[field]||0;
  if(!av||!bv)return Number(!av)-Number(!bv)||a.bvid.localeCompare(b.bvid);
  return (sort==='published_asc'?av-bv:bv-av)||a.bvid.localeCompare(b.bvid);
 });
}
