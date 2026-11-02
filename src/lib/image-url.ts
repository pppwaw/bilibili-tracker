/** Normalize Bilibili CDN URLs without allowing arbitrary image hosts. */
export function coverUrl(src:string):string{
 try{
  const url=new URL(src.startsWith('//')?'https:'+src:src);
  if(!['http:','https:'].includes(url.protocol)||url.username||url.password||url.port)return '';
  if(!['hdslb.com','biliimg.com'].some(domain=>url.hostname===domain||url.hostname.endsWith('.'+domain)))return '';
  url.protocol='https:';return url.href;
 }catch{return ''}
}
