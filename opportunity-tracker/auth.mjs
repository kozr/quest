import { createHmac, createHash, randomBytes, timingSafeEqual } from 'node:crypto';

const cookieName='tracker_session';
const lifetime=7*24*60*60;
const digest=value=>createHash('sha256').update(value).digest();
const equal=(left,right)=>timingSafeEqual(digest(left),digest(right));

export function createAuth({password,secret,secure=true}) {
  if(typeof password!=='string'||password.length<16||typeof secret!=='string'||secret.length<32) throw new Error('Hosted login requires TRACKER_PASSWORD (16+ characters) and TRACKER_SESSION_SECRET (32+ characters).');
  const sign=value=>createHmac('sha256',secret).update(value).digest('base64url');
  const payload=req=>{
    const encoded=req.headers.cookie?.split(';').map(x=>x.trim()).find(x=>x.startsWith(`${cookieName}=`))?.slice(cookieName.length+1);
    if(!encoded||encoded.length>512) return null;
    const [body,signature,...extra]=encoded.split('.');
    if(extra.length||!body||!signature||!equal(sign(body),signature)) return null;
    try {
      const session=JSON.parse(Buffer.from(body,'base64url').toString('utf8'));
      return typeof session.nonce==='string'&&session.expiresAt>Date.now()&&session.expiresAt<=Date.now()+(lifetime+60)*1000 ? body : null;
    } catch { return null; }
  };
  const cookie=value=>`${cookieName}=${value}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${value?lifetime:0}${secure?'; Secure':''}`;
  return {
    validPassword:value=>typeof value==='string'&&value.length<=1024&&equal(value,password),
    authenticated:req=>Boolean(payload(req)),
    csrf:req=>{const body=payload(req); return body?sign(`csrf:${body}`):null;},
    login:res=>{
      const body=Buffer.from(JSON.stringify({nonce:randomBytes(24).toString('base64url'),expiresAt:Date.now()+lifetime*1000})).toString('base64url');
      res.set('Set-Cookie',cookie(`${body}.${sign(body)}`));
    },
    logout:res=>res.set('Set-Cookie',cookie('')),
  };
}
