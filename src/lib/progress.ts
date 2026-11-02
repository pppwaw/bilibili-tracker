import type {PageProgress,Status,Override} from './types.ts';
export function calculateStatus(pages:PageProgress[],threshold:number,publishedAt:number,baseline:number,override:Override=null):{status:Status;progress:number}{
 const total=pages.reduce((s,p)=>s+p.duration,0);
 const watched=pages.reduce((s,p)=>s+(p.completed?p.duration:Math.min(p.duration,Math.max(0,p.progress??0))),0);
 const progress=total>0?Math.min(100,watched/total*100):0;
 if(override)return {status:override,progress:override==='completed'?100:progress};
 if(pages.length&&pages.every(p=>p.completed||(p.duration>0&&p.progress!==null&&p.progress/p.duration*100>=threshold)))return {status:'completed',progress};
 if(pages.some(p=>p.progress!==null||p.completed))return {status:'watching',progress};
 return {status:'unwatched',progress};
}
