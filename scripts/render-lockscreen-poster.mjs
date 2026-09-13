import { chromium } from 'playwright';
import { readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';
import path from 'node:path';

const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const campaign=path.join(root,'ios/AppStoreMetadata/marketing');
const template=await readFile(path.join(campaign,'posters.html'),'utf8');
let first=template.match(/<article class="poster one"[\s\S]*?<\/article>/)[0];
first=first.replace('App preview · Sample data','Lock-screen mockup · Sample notifications')
  .replace('../en-CA/screenshots/iphone-6.9/01-activity.png','assets/lockscreen-notifications-mockup.png')
  .replace("Questline's activity feed displaying sample purchases and renewals",'Illustrative lock screen showing six sample Questline purchase and renewal alerts')
  .replace(/\s*<div class="detail purchase">[\s\S]*?<\/div>/,'');
const header=template.split('<main>')[0];
const html=header.replace('<title>Questline — App Store campaign</title>','<title>Questline — Lock-screen marketing concept</title>')
  +`<style>main{padding:0}.one .phone{top:964px}</style><main>${first}</main></body></html>`;
await writeFile(path.join(campaign,'lockscreen-poster.html'),html);
const browser=await chromium.launch({headless:true,channel:'chrome'});
try{
  const page=await browser.newPage({viewport:{width:1320,height:2868},deviceScaleFactor:1});
  await page.goto(pathToFileURL(path.join(campaign,'lockscreen-poster.html')).href);
  await page.evaluate(async()=>{await document.fonts.ready;await Promise.all([...document.images].map(i=>i.decode()));});
  const valid=await page.locator('h1').evaluate(h=>h.scrollWidth<=h.clientWidth);
  if(!valid)throw new Error('Headline overflow');
  const file=path.join(campaign,'lockscreen-poster-concept.png');
  await page.screenshot({path:file,omitBackground:false});
  const png=await readFile(file);
  if(png.readUInt32BE(16)!==1320||png.readUInt32BE(20)!==2868||png[25]!==2)throw new Error('Invalid PNG format');
  await page.setViewportSize({width:660,height:1434});
  await page.addStyleTag({content:'body{width:660px;height:1434px;overflow:hidden}main{transform:scale(.5);transform-origin:top left}'});
  await page.screenshot({path:path.join(campaign,'lockscreen-poster-preview.png')});
  console.log('Lock-screen concept rendered: 1320 × 2868 RGB PNG; preview 660 × 1434.');
}finally{await browser.close();}
