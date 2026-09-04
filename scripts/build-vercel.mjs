import {mkdir,cp,writeFile} from 'node:fs/promises';

const project=process.env.FIREBASE_PROJECT_ID;
const region=process.env.IAP_FUNCTION_REGION ?? 'us-central1';
if(!project || !/^[a-z][a-z0-9-]{4,28}[a-z0-9]$/.test(project) || project.startsWith('demo-')) throw new Error('Set a real FIREBASE_PROJECT_ID in Vercel before building.');
if(!/^[a-z]+-[a-z]+[0-9]$/.test(region)) throw new Error('Invalid IAP_FUNCTION_REGION.');
const backend=`https://${region}-${project}.cloudfunctions.net/api`;
await mkdir('.vercel/output/static',{recursive:true});
await cp('web','.vercel/output/static',{recursive:true});
await writeFile('.vercel/output/config.json',JSON.stringify({version:3,routes:[
  // The browser stays same-origin: HttpOnly cookies and strict Origin checks still apply.
  {src:'^/(api(?:/.*)?|webhooks(?:/.*)?|healthz)$',dest:`${backend}/$1`},
  {handle:'filesystem'},
]},null,2));
console.log('Built static web app with same-origin Firebase API/webhook rewrites.');
