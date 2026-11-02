'use client';
import {useEffect,useState} from 'react';
import {readRoute,routeHref} from '../lib/route-state';
import type {RouteState} from '../lib/route-state';
export function useRouteState(){
 const [route,setRoute]=useState(()=>readRoute(''));
 useEffect(()=>{const read=()=>{const next=readRoute(window.location.search,window.location.pathname);const canonical=routeHref(next);if(canonical!==window.location.pathname+window.location.search)window.history.replaceState(window.history.state,'',canonical);setRoute(next)};read();window.addEventListener('popstate',read);window.addEventListener('routechange',read);return()=>{window.removeEventListener('popstate',read);window.removeEventListener('routechange',read)}},[]);
 function update(patch:Partial<RouteState>,resetPage=false,replace=false){
  const next={...readRoute(window.location.search,window.location.pathname),...(resetPage?{page:1}:{}),...patch};
  const href=routeHref(next);
  if(href!==window.location.pathname+window.location.search){window.history[replace?'replaceState':'pushState'](window.history.state,'',href);window.dispatchEvent(new Event('routechange'))}
 }
 return [route,update] as const;
}
