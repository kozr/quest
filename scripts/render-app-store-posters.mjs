import { chromium } from 'playwright';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';
import path from 'node:path';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const campaign = path.join(root, 'ios/AppStoreMetadata/marketing');
const output = path.join(campaign, 'exports/iphone-6.9');
const ids = ['01-purchase-notifications','02-every-purchase','03-all-your-apps','04-choose-your-alerts'];
await mkdir(output, { recursive: true });
const browser = await chromium.launch({ headless: true, channel: 'chrome' });
try {
  const page = await browser.newPage({ viewport: { width: 1320, height: 2868 }, deviceScaleFactor: 1 });
  for (const id of ids) {
    const url = pathToFileURL(path.join(campaign,'posters.html'));
    url.searchParams.set('poster',id);
    await page.goto(url.href);
    await page.evaluate(async () => {
      await document.fonts.ready;
      await Promise.all([...document.images].map(image => image.decode()));
    });
    const layout = await page.locator('.selected').evaluate(el => {
      const title = el.querySelector('h1');
      const bounds = el.getBoundingClientRect();
      return { title: el.getAttribute('aria-label'), width: bounds.width, height: bounds.height, titleFits: title.scrollWidth <= title.clientWidth };
    });
    if (!layout.titleFits || layout.width !== 1320 || layout.height !== 2868) throw new Error(`Invalid layout: ${id}`);
    await page.screenshot({ path: path.join(output,`${id}.png`), type: 'png', omitBackground: false });
    const png = await readFile(path.join(output,`${id}.png`));
    if (png.readUInt32BE(16) !== 1320 || png.readUInt32BE(20) !== 2868 || png[25] !== 2) throw new Error(`Invalid PNG format: ${id}`);
    console.log(JSON.stringify({ id, ...layout }));
  }
  const thumbnails = await Promise.all(ids.map(async id => ({ id, src: `data:image/png;base64,${(await readFile(path.join(output,`${id}.png`))).toString('base64')}` })));
  await page.setViewportSize({ width: 1480, height: 884 });
  await page.setContent(`<html><style>*{box-sizing:border-box}body{margin:0;padding:32px;background:#0a1022;font-family:-apple-system,BlinkMacSystemFont,sans-serif;color:#b5c3da}.row{display:flex;gap:20px}.item{width:339px}.item img{display:block;width:339px;height:737px;border-radius:9px}.label{font-size:15px;padding:17px 0}h1{font-size:20px;margin:0 0 25px;color:white}</style><h1>Questline · App Store campaign</h1><div class="row">${thumbnails.map(({id,src})=>`<div class="item"><img src="${src}"><div class="label">${id.replaceAll('-',' ')}</div></div>`).join('')}</div></html>`);
  await page.evaluate(async()=>Promise.all([...document.images].map(image=>image.decode())));
  await page.screenshot({ path: path.join(campaign,'preview.png') });
  await writeFile(path.join(campaign,'manifest.json'), JSON.stringify({ theme:'orange',background:'#F05A16',width:1320,height:2868,format:'PNG',locale:'en-CA',posters:ids.map(id=>`exports/iphone-6.9/${id}.png`),uploaded:false },null,2)+'\n');
  const icon = await readFile(path.join(root,'ios/IAPNotifications/Assets.xcassets/AppIcon.appiconset/AppIcon.png'));
  await page.setViewportSize({ width: 800, height: 440 });
  await page.setContent(`<html><style>*{box-sizing:border-box}body{margin:0;background:#f5f2ed;display:flex;align-items:center;justify-content:center;gap:38px;height:440px;font-family:-apple-system,BlinkMacSystemFont,sans-serif;color:#222428}img{width:220px;height:220px;border-radius:49px;box-shadow:0 14px 32px #7b301018}h1{font-size:62px;letter-spacing:-3px;margin:0;font-weight:750}p{font-size:20px;color:#77706a;margin:10px 0 0}</style><img src="data:image/png;base64,${icon.toString('base64')}" alt="Orange Questline Q app icon"><div><h1>Questline</h1><p>Purchase notifications. In real time.</p></div></html>`);
  await page.evaluate(async()=>{await document.fonts.ready;await Promise.all([...document.images].map(image=>image.decode()));});
  await page.screenshot({ path: path.join(campaign,'logo-preview.png') });
} finally { await browser.close(); }
