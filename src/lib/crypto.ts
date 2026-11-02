import {createCipheriv,createDecipheriv,randomBytes} from 'node:crypto';
function key(){const value=process.env.ENCRYPTION_KEY||'';if(!/^[a-f\d]{64}$/i.test(value))throw new Error('ENCRYPTION_KEY 必须为 64 位十六进制密钥');return Buffer.from(value,'hex')}
export function encrypt(text:string){const iv=randomBytes(12),cipher=createCipheriv('aes-256-gcm',key(),iv),data=Buffer.concat([cipher.update(text,'utf8'),cipher.final()]);return Buffer.concat([iv,cipher.getAuthTag(),data]).toString('base64')}
export function decrypt(text:string){const data=Buffer.from(text,'base64'),decipher=createDecipheriv('aes-256-gcm',key(),data.subarray(0,12));decipher.setAuthTag(data.subarray(12,28));return Buffer.concat([decipher.update(data.subarray(28)),decipher.final()]).toString('utf8')}
