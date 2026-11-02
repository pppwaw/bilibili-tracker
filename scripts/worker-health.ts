import {getKV,now} from '../src/lib/db.ts';
process.exit(now()-Number(getKV('worker_heartbeat','0'))<60?0:1);
