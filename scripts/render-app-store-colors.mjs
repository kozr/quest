import { chromium } from 'playwright';
import { mkdir, writeFile, readFile } from 'node:fs/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';
import path from 'node:path';

const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const campaign=path.join(root,'ios/AppStoreMetadata/marketing');
const themes=[{id:'green',label:'Green',hex:'#087F5B',feeling:'Growth · Positive momentum'},{id:'orange',label:'Orange',hex:'#F05A16',feeling:'Energy · A reason to celebrate'},{id:'charcoal',label:'Charcoal',hex:'#222428',feeling:'Focus · Quiet confidence'}];
const ids=['01-purchase-notifications','02-every-purchase','03-all-your-apps','04-choose-your-alerts'];
const browser=await chromium.launch({headless:true,channel:'chrome'});
try{
  const page=await browser.newPage({viewport:{width:1320,height:2868},deviceScaleFactor:1});
  for(const theme of themes){
    const dir=path.join(campaign,'color-options',theme.id);
    await mkdir(dir,{recursive:true});
    for(const id of ids){
      const url=pathToFileURL(path.join(campaign,'posters.html'));
      url.searchParams.set('poster',id);url.searchParams.set('theme',theme.id);
      await page.goto(url.href);
      await page.evaluate(async()=>{await document.fonts.ready;await Promise.all([...document.images].map(i=>i.decode()));});
      const valid=await page.locator('.selected').evaluate(el=>{const h=el.querySelector('h1');return el.clientWidth===1320&&el.clientHeight===2868&&h.scrollWidth<=h.clientWidth;});
      if(!valid)throw new Error(`Layout error: ${theme.id}/${id}`);
      const file=path.join(dir,`${id}.png`);
      await page.screenshot({path:file,omitBackground:false});
      const png=await readFile(file);
      if(png.readUInt32BE(16)!==1320||png.readUInt32BE(20)!==2868||png[25]!==2)throw new Error(`PNG format error: ${file}`);
    }
    console.log(`${theme.label}: four 1320 × 2868 RGB PNGs rendered and checked.`);
  }
  const html=`<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Questline — Color options</title><style>*{box-sizing:border-box}body{margin:0;padding:38px 40px;background:#f3f1ed;color:#202226;font-family:-apple-system,BlinkMacSystemFont,"Helvetica Neue",sans-serif}header{display:flex;justify-content:space-between;align-items:baseline;margin-bottom:25px}h1{font-size:26px;letter-spacing:-.6px;margin:0;font-weight:700}header p{margin:0;color:#656462;font-size:16px}.grid{display:grid;grid-template-columns:repeat(3,420px);gap:30px}.poster{display:block;width:420px;height:auto;border-radius:8px;box-shadow:0 6px 20px #00000010}a{color:inherit;text-decoration:none}.label{display:flex;align-items:baseline;justify-content:space-between;margin:18px 0 7px;font-size:22px;font-weight:650;letter-spacing:-.3px}.hex{font-size:14px;font-weight:450;color:#6c6a67}.feeling{font-size:15px;color:#656462;margin:0}@media(max-width:900px){body{padding:24px}.grid{grid-template-columns:repeat(3,minmax(0,1fr));gap:15px}.poster{width:100%}.label{font-size:17px}.hex{display:none}header p{display:none}}</style><header><h1>Questline · Three color directions</h1><p>Same message. Same layout. Different feeling.</p></header><main class="grid">${themes.map(t=>`<section><a href="posters.html?theme=${t.id}" title="View all four ${t.label.toLowerCase()} posters"><img class="poster" src="color-options/${t.id}/${ids[0]}.png" alt="Questline purchase notifications poster in ${t.label.toLowerCase()}"></a><div class="label"><a href="posters.html?theme=${t.id}">${t.label}</a><span class="hex">${t.hex}</span></div><p class="feeling">${t.feeling}</p></section>`).join('')}</main></html>`;
  await writeFile(path.join(campaign,'color-options.html'),html);
  await page.setViewportSize({width:1400,height:1100});
  await page.goto(pathToFileURL(path.join(campaign,'color-options.html')).href);
  await page.evaluate(async()=>{await document.fonts.ready;await Promise.all([...document.images].map(i=>i.decode()));});
  await page.screenshot({path:path.join(campaign,'color-comparison.png')});
}finally{await browser.close();}
