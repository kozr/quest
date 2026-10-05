import assert from 'node:assert/strict';
import {chromium} from '@playwright/test';
import {mkdtemp,rm,mkdir} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,dirname} from 'node:path';
import {fileURLToPath} from 'node:url';
import {once} from 'node:events';
import {createTrackerApp} from '../server.mjs';
import {qualificationRequest,budgetDay} from '../qualification.mjs';

const directory=dirname(dirname(fileURLToPath(import.meta.url))),dataDirectory=await mkdtemp(join(tmpdir(),'tracker-ai-browser-'));
const screenshots=join(directory,'.impeccable','review');await mkdir(screenshots,{recursive:true});let paid=0,collected=0;
const {app,store}=createTrackerApp({dataDirectory,qualificationEnv:{TRACKER_AI_ENABLED:'true',TRACKER_AI_MODE:'test',TRACKER_AI_DAILY_BUDGET_USD:'2',TRACKER_OPENAI_API_KEY:'mock-fixture-only'},qualificationProvider:{qualify:async job=>{
  paid++;const schema=qualificationRequest(job).text.format.schema;
  return {costMicroUsd:200,value:paid===1?{decision:'qualified',explicitIntent:true,intentEvidenceId:schema.properties.intentEvidenceId.enum[0],postEvidenceIds:[schema.properties.postEvidenceIds.items.enum.at(-1)],capabilityIds:[job.profile.capabilities[0].id],whyItFits:'Remember which figures you already own'}:{decision:'rejected',explicitIntent:false,intentEvidenceId:null,postEvidenceIds:[],capabilityIds:[],whyItFits:''}};
}},discoverFn:async()=>{
  collected++;const at=new Date().toISOString();
  return {searchedAt:at,semantic:true,sources:[{name:'Reddit watchlist',status:'ok',count:0,message:'Scripted feed, no live provider.',qualification:'Posts queued for AI review.'}],items:[],candidates:['aa123','bb234'].map(id=>({source:'Reddit watchlist',type:'post',provider:'redlib',sourceId:id,url:`https://www.reddit.com/r/smiskis/comments/${id}/fixture/`,title:'Which ones do I already have?',snippet:'I forget what is on my shelf when shopping. How can I remember the figures I already own?',publishedAt:at}))};
}});
const p=store.saveProduct({name:'Figure Shelf',url:'https://figureshelf.dev',description:'Keep a record of figures owned and missing.',capabilities:['Keep a record of figures owned and missing.'],needs:['Remember figures already owned.'],keywords:['collection spreadsheet'],aliases:['Figure Shelf'],exclusions:[],communities:['smiskis'],linkedin:false,monitoring:false});
const server=app.listen(0,'127.0.0.1');await once(server,'listening');let browser;
try {
  browser=await chromium.launch({channel:'chrome',headless:true});const page=await browser.newPage({viewport:{width:1440,height:1000}}),errors=[];page.on('pageerror',e=>errors.push(e.message));
  await page.goto(`http://127.0.0.1:${server.address().port}`);await page.getByRole('button',{name:'Figure Shelf',exact:true}).click();await page.getByRole('button',{name:'Find matches',exact:true}).click();await page.getByText('Search finished. Review the matches',{exact:false}).waitFor();
  assert.match(await page.locator('#qualification-status').textContent(),/2 queued/);assert.equal(paid,0);
  await page.getByRole('button',{name:'Review one queued post',exact:true}).click();await page.getByText('A post qualified. Review its fit evidence.',{exact:true}).waitFor();assert.equal(await page.locator('.match').count(),1);
  await page.getByText('AI fit evidence',{exact:true}).click();assert.match(await page.locator('.match blockquote').textContent(),/forget what is on my shelf/);
  await page.getByRole('button',{name:'Save',exact:true}).click();await page.getByText('Review status saved.',{exact:true}).waitFor();await page.getByRole('button',{name:'Saved 1',exact:true}).click();await page.getByText('Add a note',{exact:true}).click();await page.locator('.match textarea').fill('Keep my review after AI collection.');await page.getByRole('button',{name:'Save note',exact:true}).click();await page.getByText('Note saved.',{exact:true}).waitFor();
  await page.getByRole('button',{name:'Review one queued post',exact:true}).click();await page.getByText('The post did not fit. Its rejection is saved',{exact:false}).waitFor();assert.equal(paid,2);assert.match(await page.locator('#qualification-status').textContent(),/1 rejected/);
  await page.reload();await page.getByRole('button',{name:'Figure Shelf',exact:true}).click();await page.getByRole('button',{name:'Saved 1',exact:true}).click();await page.getByText('Notes (saved)',{exact:true}).click();assert.equal(await page.locator('.match textarea').inputValue(),'Keep my review after AI collection.');
  await page.getByRole('button',{name:'Find matches',exact:true}).click();await page.getByText('Search finished. Review the matches',{exact:false}).waitFor();assert.equal(paid,2);assert.equal(collected,2);assert.equal(await page.locator('#run-qualification').isDisabled(),true);
  const data=store.snapshot();data.aiBudget.dailyUsage[budgetDay(Date.now())].spentMicroUsd=2_000_000;store.commit(data);await page.reload();await page.getByRole('button',{name:'Figure Shelf',exact:true}).click();assert.match(await page.locator('#qualification-status').textContent(),/Daily AI allowance reached; collection continues/);assert.equal(await page.locator('#find-matches').isDisabled(),false);
  await page.screenshot({path:join(screenshots,'qualification-desktop.png'),fullPage:true});assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true);
  await page.setViewportSize({width:390,height:844});await page.screenshot({path:join(screenshots,'qualification-mobile.png'),fullPage:true});assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true);assert.deepEqual(errors,[]);
  assert.equal(store.snapshot().items.find(item=>item.productId===p.id).status,'saved');
  console.log(JSON.stringify({passed:true,provider:'mock only',paidRequests:0,mockedQualificationCalls:paid,collectionCalls:collected,screenshots,covers:['pending posts','one-post review','grounded evidence','rejection persistence','saved note reload','no repeated calls','daily budget controls','desktop/mobile layout']}));
} finally {await browser?.close();await new Promise(resolve=>server.close(resolve));await rm(dataDirectory,{recursive:true,force:true});}
