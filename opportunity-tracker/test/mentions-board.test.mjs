import test from 'node:test';
import assert from 'node:assert/strict';
import {selectedProductId,loadProductSelection,saveProductSelection} from '../ui/src/product-selection.mjs';
import {adjacentMention,localMentionLane,MENTION_PAGE_SIZE} from '../ui/src/mention-board.mjs';
import {matchesConversation} from '../ui/src/feed.mjs';
const products=[{id:'wren'},{id:'bbt'}];
const memory=()=>{const values=new Map();return {getItem:key=>values.get(key),setItem:(key,value)=>values.set(key,value)};};
test('aggregate, deleted and missing preferences resolve to one available product',()=>{
 for(const old of ['all','deleted','',undefined])assert.equal(selectedProductId(products,old),'wren');
 assert.equal(selectedProductId(products,'bbt'),'bbt');assert.equal(selectedProductId([],'all'),'');
});
test('product selection is remembered separately for each workspace',()=>{
 const storage=memory();saveProductSelection('bbt','one',storage);
 assert.equal(loadProductSelection(products,'one',storage),'bbt');assert.equal(loadProductSelection(products,'two',storage),'wren');
 saveProductSelection('all','one',storage);assert.equal(loadProductSelection(products,'one',storage),'bbt');
});
test('unavailable browser storage does not prevent selecting a product',()=>{
 const storage={getItem(){throw Error('blocked');},setItem(){throw Error('blocked');}};
 assert.equal(loadProductSelection(products,'private',storage),'wren');assert.doesNotThrow(()=>saveProductSelection('bbt','private',storage));
});
const row=(id,source='Reddit',productId='wren')=>({id,productId,source,status:'new',keywordMention:{quote:'Wren'},currentConversationRelevant:false});
test('keyword rows remain visible without a positive AI review and retain review identities',()=>{
 const item={...row('same-source'),qualification:{relevant:false},note:'keep',draft:'keep',status:'saved'};
 assert.equal(matchesConversation(item,{relevance:'mentions'}),true);
 assert.strictEqual(localMentionLane([item],'wren','reddit').items[0],item);
});
test('source pages exclude other products and include unfamiliar sources',()=>{
 assert.deepEqual(localMentionLane([row('foreign','Reddit','bbt'),row('ours')],'wren','reddit').items.map(item=>item.id),['ours']);
 assert.equal(localMentionLane([row('custom','New provider')],'wren','other').total,1);
 assert.equal(localMentionLane([row('maps','Google Maps review'),row('app','App Store review')],'wren','reviews').total,2);
});
test('every local row is reachable across bounded source pages',()=>{
 const items=Array.from({length:19},(_,index)=>row(String(index))),found=[];
 for(let page=0;page<3;page++){const lane=localMentionLane(items,'wren','reddit',page);assert.equal(lane.total,19);assert.ok(lane.items.length<=MENTION_PAGE_SIZE);found.push(...lane.items.map(item=>item.id));}
 assert.deepEqual(found,items.map(item=>item.id));
});
test('drawer navigation crosses a source page boundary using its absolute position',()=>{
 const items=Array.from({length:19},(_,index)=>row(String(index))),first={id:'reddit',page:0,...localMentionLane(items,'wren','reddit')};
 assert.deepEqual(adjacentMention([first],{lane:'reddit',item:items[7]},1),{lane:'reddit',page:1,index:0});
 const second={id:'reddit',page:1,...localMentionLane(items,'wren','reddit',1)};
 assert.deepEqual(adjacentMention([second],{lane:'reddit',item:items[8]},-1),{lane:'reddit',page:0,index:7});
});
test('drawer navigation reaches other sources and skips empty or failed columns',()=>{
 const reddit={id:'reddit',page:0,total:1,items:[row('r')]},empty={id:'instagram',page:0,total:0,items:[]},failed={id:'x',page:0,total:12,items:[],error:'failed'},web={id:'web',page:0,total:12,items:[row('w','Web')]};
 assert.deepEqual(adjacentMention([reddit,empty,failed,web],{lane:'reddit',item:reddit.items[0]},1),{lane:'web',page:0,index:0});
 assert.deepEqual(adjacentMention([reddit,empty,web],{lane:'web',item:web.items[0]},-1),{lane:'reddit',page:0,index:0});
 assert.equal(adjacentMention([reddit],{lane:'reddit',item:reddit.items[0]},1),null);
 assert.equal(adjacentMention([reddit],{lane:'reddit',item:row('removed')},1),null);
});
