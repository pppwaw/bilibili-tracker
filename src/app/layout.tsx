import type {Metadata} from 'next';
import './globals.css';
export const metadata:Metadata={title:'Bilibili Tracker · B 站合集追更',description:'真正看完，才算完成。个人 B 站合集与续看管理。',icons:{icon:'/icon.svg'},robots:{index:false,follow:false}};
export default function RootLayout({children}:{children:React.ReactNode}){return <html lang="zh-CN"><body>{children}</body></html>}
