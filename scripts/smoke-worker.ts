import {spawn} from 'node:child_process';
import {mkdtempSync,rmSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {setTimeout as delay} from 'node:timers/promises';
import {DatabaseSync} from 'node:sqlite';
const root=mkdtempSync(join(tmpdir(),'bili-worker-')),path=join(root,'worker.db');
const child=spawn(process.execPath,['--experimental-strip-types','src/worker.ts'],{env:{...process.env,DATABASE_PATH:path},stdio:['ignore','pipe','pipe']});
let errors='';child.stderr.on('data',c=>errors+=c);
try{
 await delay(1200);
 if(child.exitCode!==null)throw new Error('Worker exited: '+errors);
 const conn=new DatabaseSync(path);
 const heartbeat=Number(conn.prepare("SELECT value FROM kv WHERE key='worker_heartbeat'").get()?.value);
 if(Date.now()/1000-heartbeat>10)throw new Error('Worker heartbeat missing');
 conn.close();
 console.log('Worker boots independently, initializes SQLite and writes heartbeat.');
}finally{child.kill('SIGTERM');await new Promise<void>(resolve=>child.once('exit',()=>resolve()));rmSync(root,{recursive:true,force:true})}
