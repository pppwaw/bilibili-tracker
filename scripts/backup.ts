import {backup} from 'node:sqlite';
import {mkdirSync} from 'node:fs';
import {resolve} from 'node:path';
import {db} from '../src/lib/db.ts';
const root=resolve(process.env.BACKUP_PATH||'./backups');
mkdirSync(root,{recursive:true,mode:0o700});
const target=resolve(root,'bili-'+new Date().toISOString().replaceAll(':','-')+'.db');
await backup(db(),target);
console.log('SQLite backup saved:',target);
