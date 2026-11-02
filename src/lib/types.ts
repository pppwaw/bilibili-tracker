export type Status = 'unwatched'|'watching'|'completed'|'ignored';
export type Override = Status|null;
export interface PageProgress {cid:string;page:number;title:string;duration:number;progress:number|null;completed:number}
export interface Video {bvid:string;title:string;cover:string;author:string;duration:number;published_at:number;discovered_at:number;status:Status;progress:number;override:Override;seasons:string[];pages:PageProgress[]}
export interface Season {id:string;mid:string;title:string;cover:string;author:string;active:number;sync_enabled:boolean;synced_at:number|null;total:number;completed:number;videoIds:string[];sections:{id:string;title:string;videoIds:string[]}[]}
export interface Settings {threshold:number;historyMinutes:number;seasonMinutes:number}
export interface Dashboard {videos:Video[];seasons:Season[];settings:Settings;account:{connected:boolean;state:string;name:string;face?:string};jobs:{id:number;kind:string;status:string;requested_at:number;finished_at:number|null;message:string}[];workerHeartbeat:number;baseline:number;newSeasonDefault:boolean;likesScan:{status:string;ids:string[];matched:string[];index:number;startedAt:number}|null;detailsPending:number;workerProgress:{label:string;done:number;total:number;updatedAt:number}|null;cooldownUntil:number}
