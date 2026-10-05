const $ = id => document.getElementById(id);
let state = { products: [], items: [], searches: {}, busy: [] };
let selected = null;
let status = 'new';
let editing = null;
let searching = false;
let setupStep = 1;
let setupBusy = false;
let setupGeneration = 0;
let setupController;
let generatedSignature;
let communityChecks = [];

function node(tag, text, attributes = {}) {
  const element = document.createElement(tag);
  if (text !== undefined && text !== null) element.textContent = text;
  for (const [key,value] of Object.entries(attributes)) element.setAttribute(key,value);
  return element;
}
function link(text, url) {
  const result=node('a',text,{href:url,target:'_blank',rel:'noopener noreferrer'});
  try { if(!['http:','https:'].includes(new URL(url).protocol)) result.removeAttribute('href'); } catch { result.removeAttribute('href'); }
  return result;
}
function notice(text, error=false) {
  $('notice').textContent=text;
  $('notice').className=error?'error':'';
  $('notice').hidden=!text;
  $('notice').setAttribute('role',error?'alert':'status');
}
async function api(path, options={}) {
  const response=await fetch(`/api${path}`,{...options,headers:{'Content-Type':'application/json','X-Tracker-Token':state.token||'',...options.headers}});
  const result=await response.json();
  if(response.status===401&&path!=='/login') showLogin();
  if(!response.ok) throw new Error(result.error||'Could not complete that action. Try again.');
  return result;
}
async function reload() {
  state=await api('/state');
  $('workspace').hidden=false;
  $('login-view').hidden=true;
  $('sign-out').hidden=state.storage!=='cloud';
  $('restore-toggle').hidden=false;
  document.querySelector('a[download]').hidden=false;
  $('storage-status').textContent=(state.storage==='cloud'?'Products, matches, and notes are saved in your private cloud tracker.':'Products, matches, and notes are saved on this computer.')+' Enabled watchlists are checked every hour. Find matches runs a broader search when you choose.';
  if(selected&&!state.products.some(p=>p.id===selected)) selected=null;
  render();
}
function date(value) {
  if(!value||!Number.isFinite(Date.parse(value))) return 'Date unavailable';
  return new Date(value).toLocaleDateString(undefined,{year:'numeric',month:'short',day:'numeric'});
}
function lines(value) { return value.split(/\n/).map(x=>x.trim()).filter(Boolean); }
function productItems() { return state.items.filter(i=>!selected||i.productId===selected); }
function renderProducts() {
  $('products').replaceChildren();
  $('products-empty').hidden=state.products.length>0;
  $('all-products').setAttribute('aria-pressed',String(!selected));
  for(const product of state.products) {
    const row=node('li');
    const choice=node('button',product.name,{type:'button',class:'product-choice','aria-pressed':String(selected===product.id)});
    choice.addEventListener('click',()=>{selected=product.id;render();});
    const info=node('div',null,{class:'product-info'});
    info.append(link(product.type==='app_store'?'App Store':new URL(product.url).hostname,product.url));
    const edit=node('button','Edit',{type:'button','aria-label':`Edit ${product.name}`});
    edit.addEventListener('click',()=>openForm(product));
    info.append(edit);
    row.append(choice,info);
    $('products').append(row);
  }
}
function renderCoverage() {
  $('source-status').replaceChildren();
  const products=state.products.filter(p=>!selected||p.id===selected);
  const searches=products.map(p=>({product:p,search:state.searches[p.id]})).filter(x=>x.search);
  $('coverage').hidden=!searches.length;
  let latest=searches.map(x=>x.search.searchedAt).sort().at(-1);
  $('coverage-summary').textContent=latest?`Search coverage · last checked ${new Date(latest).toLocaleString()}`:'Search coverage';
  for(const {product,search} of searches) {
    if(!selected) $('source-status').append(node('h3',product.name));
    for(const source of search.sources||[]) {
      const row=node('div',null,{class:'source-record'});
      const label=source.status==='ok'?`Checked${Number.isFinite(source.count)?` · ${source.count} matches`:''}`:source.status==='unconfigured'?'Not configured':'Could not check';
      row.append(node('p',`${source.name}: ${label}`));
      if(source.message||source.error) row.append(node('p',source.message||source.error,{class:'secondary'}));
      if(source.queries?.length) {
        const queries=node('div',null,{class:'query-links'});
        for(const query of source.queries) if(typeof query==='object'&&query.url) queries.append(link(query.label||'Search this source',query.url));
        row.append(queries);
      }
      $('source-status').append(row);
    }
  }
}
async function changeItem(item,update,button) {
  if(button) button.disabled=true;
  try { const result=await api(`/items/${item.id}`,{method:'PATCH',body:JSON.stringify(update)}); state.items=state.items.map(i=>i.id===item.id?result.item:i); render(); notice(update.note!==undefined?'Note saved.':'Review status saved.'); } catch(error) { notice(error.message,true); if(button) button.disabled=false; }
}
function renderMatches() {
  const all=productItems();
  for(const s of ['new','saved','dismissed']) { $(`count-${s}`).textContent=all.filter(i=>i.status===s).length; document.querySelector(`[data-status="${s}"]`).setAttribute('aria-pressed',String(status===s)); }
  const filter=$('text-filter').value.toLowerCase();
  const kind=$('kind-filter').value;
  const items=all.filter(i=>i.status===status&&(kind==='all'||kind===i.kind)&&(!filter||`${i.title} ${i.snippet} ${i.source} ${i.reason}`.toLowerCase().includes(filter))).sort((a,b)=>Date.parse(b.publishedAt||b.foundAt)-Date.parse(a.publishedAt||a.foundAt));
  $('matches').replaceChildren();
  $('empty-state').hidden=items.length>0;
  $('empty-add').hidden=state.products.length>0;
  if(!items.length) {
    const checked=state.products.some(p=>(!selected||p.id===selected)&&state.searches[p.id]);
    $('empty-heading').textContent=!state.products.length?'Track something you built':filter||kind!=='all'?'No matches for these filters':status==='saved'?'No saved matches yet':status==='dismissed'?'No dismissed matches':checked?'No new matches found':'Ready to look for matches';
    $('empty-message').textContent=!state.products.length?'Add its website or App Store link, then tell the tracker which problems it solves.':filter||kind!=='all'?'Try another filter or match type.':status==='saved'?'Save a useful conversation to keep it here.':status==='dismissed'?'Dismissed matches appear here so you can restore them.':checked?'Check search coverage below the filters, or edit your product’s phrases and search again.':'Choose Find matches to search public conversations and product mentions.';
  }
  for(const item of items) {
    const article=node('article',null,{class:'match','data-item-id':item.id});
    const heading=node('h2');heading.append(link(item.title,item.url));
    const product=state.products.find(p=>p.id===item.productId);
    article.append(node('p',[item.kind==='mention'?'Mention':'Opportunity',item.source,!selected?product?.name:null,item.author?`by ${item.author}`:null,date(item.publishedAt)].filter(Boolean).join(' · '),{class:'match-meta'}),heading);
    if(item.snippet) article.append(node('p',item.snippet,{class:'match-snippet'}));
    article.append(node('p',item.reason||'Review the original discussion to judge whether this is a useful match.',{class:'match-reason'}));
    const actions=node('div',null,{class:'match-actions'});
    const addAction=(text,next)=>{const button=node('button',text,{type:'button'});button.addEventListener('click',()=>changeItem(item,{status:next},button));actions.append(button);};
    if(item.status!=='saved') addAction('Save','saved');
    if(item.status==='new'||item.status==='saved') addAction('Dismiss','dismissed');
    if(item.status!=='new') addAction('Restore to New','new');
    actions.append(link('Open discussion',item.url));
    const notes=node('details');
    notes.append(node('summary',item.note?'Notes (saved)':'Add a note'));
    const label=node('label','Your note',{for:`note-${item.id}`});
    const input=node('textarea',null,{id:`note-${item.id}`,rows:'3',maxlength:'3000'});input.value=item.note||'';
    const save=node('button','Save note',{type:'button'});save.addEventListener('click',()=>changeItem(item,{note:input.value},save));
    notes.append(label,input,save);
    article.append(actions,notes);
    $('matches').append(article);
  }
}
function render() {
  renderProducts();renderCoverage();renderMatches();
  const product=state.products.find(p=>p.id===selected);
  $('inbox-heading').textContent=product?product.name:'Matches';
  $('product-summary').textContent=product?product.description||`Watching: ${product.keywords.join(', ')}`:'Opportunities and mentions for your products.';
  $('tracking-summary').hidden=!product;
  if(product) {
    const last=state.searches[product.id]?.searchedAt;
    const mode=product.monitoring?(state.monitoring?.available?'Automatic checks every hour':'Automatic checks unavailable'):'Automatic checks paused';
    const count=product.communities?.length||0;
    $('tracking-summary').textContent=`${mode} · ${count} ${count===1?'subreddit':'subreddits'}${product.linkedin?' · LinkedIn posts':''} · ${last?`Last checked ${new Date(last).toLocaleString()}`:'No check yet'}`;
  }
  $('find-matches').disabled=searching||state.products.length===0;
}

function setupError(message='') { $('setup-error').textContent=message;$('setup-error').hidden=!message; }
function signature() {return JSON.stringify(['url','name','description'].map(key=>$(`product-${key}`).value));}
function currentDetails() {return Object.fromEntries(['url','name','description'].map(key=>[key,$(`product-${key}`).value]));}
function watchlist() {return [...new Set(lines($('product-communities').value).map(name=>name.replace(/^r\//i,'').toLowerCase()))];}
function checkNames() {
  const names=watchlist();
  if(names.length>10||names.some(name=>! /^[a-z0-9_]{2,21}$/.test(name))) throw new Error('Use up to 10 subreddit names, without links or spaces.');
  return names;
}
function renderCommunityChecks() {
  $('community-checks').replaceChildren();
  for(const name of watchlist()) {
    const check=communityChecks.find(row=>row.name===name);
    const row=node('li');row.append(link(`r/${name}`,`https://www.reddit.com/r/${encodeURIComponent(name)}/`));
    row.append(document.createTextNode(` — ${check?.message||'Not checked yet.'}`));
    $('community-checks').append(row);
  }
}
function setSetupBusy(value) {
  setupBusy=value;
  ['details','profile','monitoring'].forEach((name,index)=>{$(`setup-${name}`).disabled=value||setupStep!==index+1;});
  for(const id of ['setup-back','setup-next','save-product']) $(id).disabled=value;
  $('product-form').setAttribute('aria-busy',String(value));
}
function showStep(value, focus=true) {
  setupStep=value;setupError();
  const labels=['Product details','Review tracking','Start tracking'];
  ['details','profile','monitoring'].forEach((name,index)=>{$(`setup-${name}`).hidden=value!==index+1;});
  $('setup-progress').textContent=`${labels[value-1]} · step ${value} of 3`;
  $('setup-back').hidden=value===1;
  $('setup-next').hidden=value===3;
  $('setup-next').textContent=value===1?'Review tracking':'Continue';
  $('save-product').hidden=value!==3;
  if(value===3) {
    const names=watchlist();
    const linkedin=$('product-linkedin').checked&&Boolean(state.sources?.linkedin?.available);
    const available=Boolean(state.monitoring?.available)&&(names.length>0||linkedin);
    $('product-monitoring').disabled=!available;
    if(!available) $('product-monitoring').checked=false;
    $('monitoring-help').textContent=!state.monitoring?.available?'Automatic checks are not configured on this server. You can save and use Find matches.':!names.length&&!linkedin?'Add subreddits or enable LinkedIn in the previous step to enable automatic checks. You can also save and search manually.':'Checks run every hour, even when this page is closed. Selected Reddit thread comments and enabled LinkedIn searches are checked; coverage is partial.';
    $('setup-summary').replaceChildren(node('h3',$('product-name').value),node('p',`Watchlist: ${names.length?names.map(name=>`r/${name}`).join(', '):'No communities selected'}${linkedin?' · LinkedIn posts':''}`),node('p',`Search phrases: ${lines($('product-keywords').value).join(', ')}`));
  }
  setSetupBusy(setupBusy);
  if(focus) document.querySelector(`#setup-${['details','profile','monitoring'][value-1]} legend`).focus();
}
async function generateProfile(replace=true) {
  if(setupBusy) return false;
  const generation=setupGeneration,source=signature();
  setupController=new AbortController();setSetupBusy(true);setupError();
  $('profile-message').textContent='Preparing suggestions and checking the communities…';
  try {
    const profile=await api('/profile',{method:'POST',body:JSON.stringify(currentDetails()),signal:setupController.signal});
    if(generation!==setupGeneration||source!==signature()) return false;
    for(const key of ['capabilities','needs','keywords','communities']) if(replace||!$(`product-${key}`).value.trim()) $(`product-${key}`).value=profile[key].join('\n');
    communityChecks=profile.checks||[];renderCommunityChecks();
    generatedSignature=source;$('profile-message').textContent=profile.message+(replace?'':' Your existing entries have been kept.');
    return true;
  } catch(error) {
    if(generation===setupGeneration&&error.name!=='AbortError') {setupError(error.message);$('profile-message').textContent='Suggestions could not be prepared. You can enter the tracking profile yourself.';}
    return false;
  } finally {if(generation===setupGeneration) setSetupBusy(false);}
}
async function nextStep() {
  if(setupBusy) return;
  setupError();
  if(setupStep===1) {
    const generation=setupGeneration;
    if(!['url','name','description'].every(key=>$(`product-${key}`).reportValidity())) return;
    if(generatedSignature!==signature()) await generateProfile(!editing);
    if(generation===setupGeneration&&!$('product-form').hidden) showStep(2);
  } else if(setupStep===2) {
    if(!$('product-keywords').reportValidity()) return;
    try {checkNames();showStep(3);} catch(error){setupError(error.message);$('product-communities').focus();}
  }
}
function openForm(product=null) {
  setupController?.abort();setupGeneration++;setupBusy=false;
  editing=product?.id||null;
  $('product-form').reset();
  $('form-title').textContent=product?'Edit product':'Add product';
  $('save-product').textContent=product?'Save changes':'Start tracking';
  $('delete-product').hidden=!product;
  if(product) for(const key of ['url','name','description','capabilities','needs','communities','keywords','aliases','exclusions']) $(`product-${key}`).value=Array.isArray(product[key])?product[key].join('\n'):product[key]||'';
  $('product-monitoring').checked=product?Boolean(product.monitoring):Boolean(state.monitoring?.available);
  $('product-linkedin').checked=product?Boolean(product.linkedin):Boolean(state.sources?.linkedin?.available);
  $('product-linkedin').disabled=!state.sources?.linkedin?.available&&!$('product-linkedin').checked;
  $('linkedin-help').textContent=state.sources?.linkedin?.available?'Checks one search phrase and one product name through your saved server session. Only posts with a verified author and permalink enter the inbox; coverage is partial.':'LinkedIn collection is not configured on this server. Existing Reddit and web searches remain available.';
  generatedSignature=product?.capabilities?.length?signature():null;communityChecks=[];renderCommunityChecks();
  $('profile-message').textContent=product?'Review your saved needs, phrases, and watchlist. Refresh suggestions if the product has changed.':'Suggestions will be prepared from your product details.';
  $('product-form').hidden=false;
  showStep(1,false);
  $('import-message').hidden=true;
  $('product-url').focus();
  $('product-form').scrollIntoView({block:'nearest'});
}
function closeForm() {setupController?.abort();setupGeneration++;setupBusy=false;$('product-form').hidden=true;editing=null;$('add-product').focus();}
async function findMatches(productIds) {
  if(searching) return;
  const ids=productIds||state.products.filter(p=>!selected||p.id===selected).map(p=>p.id);
  if(!ids.length) return;
  searching=true;render();notice('');$('search-progress').hidden=false;
  let failures=0;
  for(let index=0;index<ids.length;index++) {
    const product=state.products.find(p=>p.id===ids[index]);
    if(!product) continue;
    $('search-progress').textContent=`Finding matches for ${product.name}${ids.length>1?` (${index+1} of ${ids.length})`:''}…`;
    try { await api(`/products/${ids[index]}/search`,{method:'POST',body:'{}'});await reload(); } catch(error) { failures++;notice(error.message,true); }
  }
  searching=false;$('search-progress').hidden=true;render();
  $('coverage').open=true;
  if(!failures) {
    const sources=ids.flatMap(id=>state.searches[id]?.sources||[]);
    const checked=sources.filter(s=>s.status==='ok').length;
    notice(checked?'Search finished. Review the matches and source coverage.':'No source could be checked. Use the source search links or try again.',!checked);
  }
}

$('add-product').addEventListener('click',()=>openForm());
$('empty-add').addEventListener('click',()=>openForm());
$('cancel-product').addEventListener('click',closeForm);
$('setup-next').addEventListener('click',nextStep);
$('setup-back').addEventListener('click',()=>showStep(setupStep-1));
$('suggest-profile').addEventListener('click',()=>generateProfile());
$('product-communities').addEventListener('input',()=>{communityChecks=[];renderCommunityChecks();});
$('check-communities').addEventListener('click',async()=>{
  if(setupBusy) return;
  const generation=setupGeneration;
  setupController=new AbortController();
  try {
    const names=checkNames();setSetupBusy(true);setupError();
    $('community-message').hidden=false;$('community-message').textContent='Checking public subreddit feeds…';
    const result=await api('/communities/check',{method:'POST',body:JSON.stringify({communities:names}),signal:setupController.signal});
    if(generation!==setupGeneration) return;
    communityChecks=result.checks;renderCommunityChecks();$('community-message').textContent='Checks finished. Communities that could not be checked remain unverified.';
  } catch(error) {if(generation===setupGeneration&&error.name!=='AbortError') setupError(error.message);}
  finally {if(generation===setupGeneration) setSetupBusy(false);}
});
$('all-products').addEventListener('click',()=>{selected=null;render();});
$('kind-filter').addEventListener('change',renderMatches);
$('text-filter').addEventListener('input',renderMatches);
document.querySelectorAll('[data-status]').forEach(button=>button.addEventListener('click',()=>{status=button.dataset.status;renderMatches();}));
$('find-matches').addEventListener('click',()=>findMatches());
$('import-details').addEventListener('click',async()=>{
  const generation=setupGeneration;setupController=new AbortController();
  const button=$('import-details');setSetupBusy(true);button.textContent='Importing…';$('import-message').hidden=true;
  try {
    const product=await api('/metadata',{method:'POST',body:JSON.stringify({url:$('product-url').value}),signal:setupController.signal});
    if(generation!==setupGeneration) return;
    $('product-url').value=product.url;$('product-name').value=product.name;$('product-description').value=product.description;
    if(!$('product-aliases').value) $('product-aliases').value=product.name;
    generatedSignature=null;$('import-message').textContent='Details imported. Check them, then choose Review tracking for suggestions.';
    $('product-name').focus();
  } catch(error) {if(generation===setupGeneration&&error.name!=='AbortError') $('import-message').textContent=`${error.message} You can fill in the name and description yourself.`;}
  finally {if(generation===setupGeneration) {setSetupBusy(false);button.textContent='Import details from link';$('import-message').hidden=false;}}
});
$('product-form').addEventListener('submit',async event=>{
  event.preventDefault();
  if(setupStep!==3) return nextStep();
  if(setupBusy) return;
  const priorId=editing;const button=$('save-product');button.disabled=true;
  const product={};
  for(const key of ['url','name','description']) product[key]=$(`product-${key}`).value;
  for(const key of ['keywords','aliases','exclusions','capabilities','needs']) product[key]=lines($(`product-${key}`).value);
  product.communities=watchlist();product.monitoring=$('product-monitoring').checked;
  product.linkedin=$('product-linkedin').checked;
  if(!product.aliases.length) product.aliases=[product.name];
  try {
    const result=await api(priorId?`/products/${priorId}`:'/products',{method:priorId?'PUT':'POST',body:JSON.stringify(product)});
    selected=result.product.id;status='new';closeForm();await reload();notice('Product saved.');
    if(!priorId) await findMatches([result.product.id]);
  } catch(error) { setupError(error.message); }
  finally { button.disabled=false; }
});
$('delete-product').addEventListener('click',async()=>{
  if(!editing||!confirm('Delete this product and its saved matches and notes? Export a backup first if you need them.')) return;
  try { await api(`/products/${editing}`,{method:'DELETE'});closeForm();await reload();notice('Product deleted.'); } catch(error) { notice(error.message,true); }
});
function restoreVisibility(visible) { $('restore-form').hidden=!visible;$('restore-toggle').setAttribute('aria-expanded',String(visible)); }
$('restore-toggle').addEventListener('click',()=>restoreVisibility($('restore-form').hidden));
$('restore-cancel').addEventListener('click',()=>restoreVisibility(false));
$('restore-form').addEventListener('submit',async event=>{
  event.preventDefault();const file=$('backup-file').files[0];if(!file) return;
  if(!confirm('Replace all current tracker data with this backup?')) return;
  try { if(file.size>2_000_000) throw new Error('The backup is too large.');const data=JSON.parse(await file.text());await api('/import',{method:'POST',body:JSON.stringify(data)});selected=null;restoreVisibility(false);await reload();notice('Backup restored.'); } catch(error) { notice(error.message,true); }
});
function showLogin() {
  setupController?.abort();setupGeneration++;$('product-form').hidden=true;
  state={products:[],items:[],searches:{},busy:[]};selected=null;
  $('workspace').hidden=true;$('login-view').hidden=false;$('sign-out').hidden=true;
  $('restore-toggle').hidden=true;document.querySelector('a[download]').hidden=true;
  $('restore-form').hidden=true;$('matches').replaceChildren();$('products').replaceChildren();
  $('tracker-password').focus();
}
$('login-form').addEventListener('submit',async event=>{
  event.preventDefault();$('sign-in').disabled=true;
  try {await api('/login',{method:'POST',body:JSON.stringify({password:$('tracker-password').value})});$('tracker-password').value='';await reload();notice('');}
  catch(error){notice(error.message,true);}finally{$('sign-in').disabled=false;}
});
$('sign-out').addEventListener('click',async()=>{
  try {await api('/logout',{method:'POST',body:'{}'});showLogin();notice('Signed out.');}catch(error){notice(error.message,true);}
});
async function start() {
  const auth=await api('/auth');
  if(auth.hosted&&!auth.authenticated) {
    $('storage-status').textContent='Your private cloud tracker. Sign in to open your products and matches.';
    showLogin();
  } else await reload();
}
start().catch(error=>{notice(`Could not load the tracker: ${error.message} Refresh to try again.`,true);$('empty-heading').textContent='Tracker unavailable';$('empty-message').textContent='Check the tracker configuration, then refresh this page.';});
setInterval(()=>{
  if(document.visibilityState==='visible'&&state.token&&!searching&&$('product-form').hidden&&!document.activeElement?.matches('input, textarea, select')&&!document.querySelector('.match details[open]')) reload().catch(()=>{});
},60000);
