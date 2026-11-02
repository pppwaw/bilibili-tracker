import type { NextConfig } from 'next';
const config: NextConfig = {
 output:'standalone',poweredByHeader:false,
 async headers(){return [{source:'/:path*',headers:[
 {key:'X-Robots-Tag',value:'noindex, nofollow, noarchive'},
 {key:'X-Content-Type-Options',value:'nosniff'},
 {key:'Referrer-Policy',value:'no-referrer'},
 {key:'X-Frame-Options',value:'DENY'},
 {key:'Content-Security-Policy',value:"default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data: https://*.hdslb.com https://hdslb.com https://*.biliimg.com https://biliimg.com; connect-src 'self'; frame-ancestors 'none'; base-uri 'self'; form-action 'self'"}
 ]}];}
}; export default config;
