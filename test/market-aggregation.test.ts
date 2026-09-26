import {test} from 'node:test';
import assert from 'node:assert/strict';
import {Timestamp} from 'firebase-admin/firestore';
import {aggregateMarketEvidence,makeMarketObservation,resolveCanonicalProblems} from '../src/market-aggregation.js';
import type {MarketAnalysisGroup,MarketAnalysisObservation,MarketObservation,MarketProblemRecord,MarketSource} from '../src/market-types.js';

const now=Date.parse('2026-09-24T12:00:00.000Z');
const USER='account-a',APP='app-a',REVISION=3;
const problemID='60000000-0000-4000-8000-000000000001';
const capabilityID='70000000-0000-4000-8000-000000000001';

function source(input:Partial<MarketSource>&Pick<MarketSource,'id'>):MarketSource {
  const createdAt=input.createdAt??new Date(now-60_000).toISOString();
  const fetchedAt=input.fetchedAt??new Date(now).toISOString();
  const contentHash=input.contentHash??`hash-${input.id}`;
  const expiry=input.expireAt??Timestamp.fromMillis(now+86_400_000);
  return {
    id:input.id,provider:'reddit',kind:input.kind??'post',threadId:input.threadId??input.id,parentId:input.parentId??null,
    authorKey:input.authorKey??null,authorDisplayName:input.authorDisplayName??null,title:input.title??'A source title',
    text:input.text??'An exact source quote about the problem.',community:input.community??'collectors',url:input.url??`https://www.reddit.com/r/collectors/comments/${input.id}/`,
    createdAt,fetchedAt,contentHash,expiresAt:input.expiresAt??new Date(expiry.toMillis()).toISOString(),expireAt:expiry,
  };
}

function problem(input:Partial<MarketProblemRecord>&Pick<MarketProblemRecord,'id'>={}):MarketProblemRecord {
  return {id:input.id??problemID,user_id:input.user_id??USER,app_id:input.app_id??APP,title:input.title??'Tracking missing figures',
    summary:input.summary??'Collectors struggle to remember which figures are missing.',signalKind:input.signalKind??'recurring_problem',
    groupKey:input.groupKey??'missing-figures',createdAt:input.createdAt??new Date(now-86_400_000).toISOString(),
    ...(input.sourceAnchors?{sourceAnchors:input.sourceAnchors}:{}),...(input.capabilityAnchors?{capabilityAnchors:input.capabilityAnchors}:{}),
    ...(input.profileProblemAnchors?{profileProblemAnchors:input.profileProblemAnchors}:{}),
    updatedAt:input.updatedAt??new Date(now).toISOString(),expireAt:input.expireAt??Timestamp.fromMillis(now+30*86_400_000)};
}

function analysis(input:Partial<MarketAnalysisObservation>&Pick<MarketAnalysisObservation,'sourceId'|'quote'>):MarketAnalysisObservation {
  return {sourceId:input.sourceId,quote:input.quote,explanation:input.explanation??'The source describes the stated problem.',
    prospectReason:input.prospectReason??'The source describes a relevant situation.',needStatus:input.needStatus??'unresolved',
    isProductBuilder:input.isProductBuilder??false,isSatisfied:input.isSatisfied??false,
    matchedCapabilityIds:input.matchedCapabilityIds??[],competitorName:input.competitorName??null};
}

function observation(sourceRow:MarketSource,input:Partial<MarketAnalysisObservation>&Pick<MarketAnalysisObservation,'quote'> & {problemId?:string;signalKind?:MarketObservation['signalKind'];
  userId?:string;appId?:string;revision?:number;observedAt?:string;id?:string}={}):MarketObservation {
  return makeMarketObservation({userId:input.userId??USER,appId:input.appId??APP,revision:input.revision??REVISION,
    problemId:input.problemId??problemID,source:sourceRow,observation:analysis({sourceId:sourceRow.id,quote:input.quote,...input}),
    signalKind:input.signalKind??'recurring_problem',model:'mock-model',now:input.observedAt?Date.parse(input.observedAt):now});
}

function aggregate(sources:MarketSource[],observations:MarketObservation[],problemRows=[problem()],patch:Partial<{userId:string;appId:string;revision:number;now:number;sourceContentHashes:Record<string,string>}>={}) {
  return aggregateMarketEvidence({sources,observations,problemRows,userId:patch.userId??USER,appId:patch.appId??APP,
    revision:patch.revision??REVISION,now:patch.now??now,...(patch.sourceContentHashes?{sourceContentHashes:patch.sourceContentHashes}:{})});
}

test('counts distinct authors and conversations, merging a known username alias once',()=>{
  const rows=[
    source({id:'post-one',threadId:'thread-one',authorKey:'reddit:t2_authorone',authorDisplayName:'Mira'}),
    source({id:'comment-alias',kind:'comment',threadId:'thread-one',parentId:'t3_post-one',authorKey:'reddit:name:mira',authorDisplayName:'mira'}),
    source({id:'comment-two',kind:'comment',threadId:'thread-one',parentId:'t3_post-one',authorKey:'reddit:t2_authortwo',authorDisplayName:'Jules'}),
    source({id:'deleted-author',kind:'comment',threadId:'thread-two',parentId:'t3_post-two',authorKey:null,authorDisplayName:null}),
  ];
  const observations=rows.map((row,index)=>observation(row,{quote:row.text,observedAt:new Date(now+index).toISOString()}));
  const result=aggregate(rows,observations);
  assert.equal(result.problems[0]?.peopleCount,2);
  assert.equal(result.problems[0]?.conversationCount,2);
  assert.equal(result.problems[0]?.observationCount,4);
  assert.equal(result.problems[0]?.signalKind,'recurring_problem');
  assert.equal(result.evidence.length,4);
  assert.equal(result.validSources.length,4);
});

test('unknown authors do not inflate people, and one known author cannot establish recurrence',()=>{
  const rows=[
    source({id:'solo-post',threadId:'one',authorKey:'reddit:t2_onlyauthor',authorDisplayName:'Ivy'}),
    source({id:'solo-comment',kind:'comment',threadId:'one',parentId:'t3_solo-post',authorKey:'reddit:t2_onlyauthor',authorDisplayName:'Ivy'}),
    source({id:'anonymous-comment',kind:'comment',threadId:'two',parentId:'t3_other',authorKey:null,authorDisplayName:null}),
  ];
  const result=aggregate(rows,rows.map(row=>observation(row,{quote:row.text})));
  assert.equal(result.problems[0]?.peopleCount,1);
  assert.equal(result.problems[0]?.conversationCount,2);
  assert.equal(result.problems[0]?.signalKind,'workaround');
});

test('expired, changed, cross-account, cross-app, and stale-revision observations are excluded',()=>{
  const valid=source({id:'valid'});
  const expired=source({id:'expired',expireAt:Timestamp.fromMillis(now)});
  const changed=source({id:'changed',contentHash:'new-hash'});
  const accountRow=source({id:'account-row'}),appRow=source({id:'app-row'}),revisionRow=source({id:'revision-row'});
  const rows=[valid,expired,changed,accountRow,appRow,revisionRow];
  const observations=[
    observation(valid,{quote:valid.text}),
    observation(expired,{quote:expired.text}),
    observation(source({id:'changed',contentHash:'old-hash'}),{quote:'old snapshot text'}),
    observation(accountRow,{quote:accountRow.text,userId:'other-account'}),
    observation(appRow,{quote:appRow.text,appId:'other-app'}),
    observation(revisionRow,{quote:revisionRow.text,revision:REVISION-1}),
  ];
  const result=aggregate(rows,observations);
  assert.deepEqual(result.validObservations.map(row=>row.sourceId),['valid']);
  assert.ok(result.validSources.some(row=>row.id==='valid'));
  assert.ok(!result.validSources.some(row=>row.id==='expired'));
  assert.equal(result.problems[0]?.peopleCount,0);
  assert.equal(result.problems[0]?.observationCount,1);
  const snapshotInvalidated=aggregate([valid],[observation(valid,{quote:valid.text})],[problem()],
    {sourceContentHashes:{valid:'previous-content-hash'}});
  assert.equal(snapshotInvalidated.validObservations.length,0);
  assert.equal(snapshotInvalidated.problems.length,0);
});

test('reuses canonical problem identity after title edits and coalesces duplicate new groups by group key',()=>{
  const existing=problem({title:'Missing figure tracking',summary:'Collectors cannot remember absent figures.'});
  const edited:MarketAnalysisGroup={problemId:null,groupKey:existing.groupKey,title:'Tracking missing figures',
    summary:'People lose track of which figures they still need.',signalKind:'recurring_problem',observations:[]};
  const reuse=resolveCanonicalProblems([edited],[existing],USER,APP,now);
  assert.equal(reuse.groupProblemIDs.get(edited),existing.id);
  assert.equal(reuse.rows.length,1);
  assert.equal(reuse.rows[0]?.createdAt,existing.createdAt);

  const first:MarketAnalysisGroup={...edited,problemId:null,groupKey:'subscription-frustration',title:'Subscription frustration',
    summary:'People dislike recurring costs for this service.'};
  const duplicate:MarketAnalysisGroup={...first,summary:'People dislike the recurring charges for this service.'};
  const created=resolveCanonicalProblems([first,duplicate],[existing],USER,APP,now);
  assert.equal(created.groupProblemIDs.get(first),created.groupProblemIDs.get(duplicate));
  assert.equal(created.rows.length,1);

  const anchoredExisting=problem({id:'60000000-0000-4000-8000-000000000003',groupKey:'old-label',
    title:'Remembering owned collectibles',summary:'Collectors need a reliable inventory of items they already own.',sourceAnchors:['shared-source'],capabilityAnchors:[capabilityID]});
  const anchoredGroup=(groupKey:string,title:string,summary:string):MarketAnalysisGroup=>({problemId:null,groupKey,title,summary,
    signalKind:'recurring_problem',observations:[analysis({sourceId:'shared-source',quote:'The exact complaint',matchedCapabilityIds:[capabilityID]})]});
  const renamed=anchoredGroup('renamed-label','Tracking owned collectibles','Collectors need a dependable inventory of collectibles they already own.');
  const distinct=anchoredGroup('different-issue','Finding missing collectibles','Collectors cannot locate missing items within a long series.');
  const byAnchors=resolveCanonicalProblems([renamed,distinct],[anchoredExisting],USER,APP,now);
  assert.equal(byAnchors.groupProblemIDs.get(renamed),anchoredExisting.id,'related title edits preserve canonical identity');
  assert.notEqual(byAnchors.groupProblemIDs.get(distinct),anchoredExisting.id,'one shared post and capability do not merge a different problem');
  assert.equal(new Set(byAnchors.groupProblemIDs.values()).size,2);
  assert.equal(byAnchors.rows.length,2);
});

test('every problem representative resolves to returned evidence and lastObservedAt uses source dates',()=>{
  const sources:MarketSource[]=[],observations:MarketObservation[]=[],problemRows:MarketProblemRecord[]=[];
  const latestSourceDate=now-86_400_000;
  for(let groupIndex=0;groupIndex<9;groupIndex++) {
    const id=`80000000-0000-4000-8000-${String(groupIndex+1).padStart(12,'0')}`;
    problemRows.push(problem({id,title:`Problem group ${groupIndex}`,groupKey:`group-${groupIndex}`}));
    for(let rowIndex=0;rowIndex<12;rowIndex++) {
      const sourceDate=groupIndex===8?now-29*86_400_000:now-86_400_000-rowIndex*1000;
      const row=source({id:`g${groupIndex}-s${String(rowIndex).padStart(2,'0')}`,threadId:`g${groupIndex}-thread-${rowIndex}`,
        createdAt:new Date(sourceDate).toISOString(),authorKey:null,authorDisplayName:null});
      sources.push(row);
      observations.push(observation(row,{problemId:id,quote:row.text,observedAt:new Date(now).toISOString()}));
      if(groupIndex===8&&rowIndex===11) {
        const created=Date.parse(row.createdAt);assert.equal(created,now-29*86_400_000);
      }
      if(groupIndex===0&&rowIndex===0) assert.equal(Date.parse(row.createdAt),latestSourceDate);
    }
  }
  const result=aggregate(sources,observations,problemRows);
  const evidenceIDs=new Set(result.evidence.map(row=>row.id));
  assert.equal(result.problems.length,9);
  assert.ok(result.evidence.length<=100);
  for(const row of result.problems) {
    assert.ok(row.representativeEvidenceId);
    assert.ok(evidenceIDs.has(row.representativeEvidenceId!),`representative evidence missing for ${row.id}`);
  }
  const firstProblem=result.problems.find(row=>row.id===problemRows[0]!.id)!;
  assert.equal(firstProblem.lastObservedAt,new Date(latestSourceDate).toISOString());
  const oldProblem=result.problems.find(row=>row.id===problemRows[8]!.id)!;
  assert.equal(oldProblem.lastObservedAt,new Date(now-29*86_400_000).toISOString());
});

test('competitor complaint stays useful intelligence without becoming a prospect; supported unresolved need can qualify',()=>{
  const complaint=source({id:'complaint',threadId:'complaint-thread',authorKey:'reddit:t2_complainer'});
  const unresolved=source({id:'unresolved',threadId:'need-thread',authorKey:'reddit:t2_collector'});
  const rows=[problem({id:problemID,signalKind:'competitor_complaint',groupKey:'competitor-complaint'}),
    problem({id:'60000000-0000-4000-8000-000000000002',signalKind:'recurring_problem',groupKey:'need'})];
  const obs=[observation(complaint,{problemId:rows[0]!.id,signalKind:'competitor_complaint',quote:complaint.text,needStatus:'unresolved'}),
    observation(unresolved,{problemId:rows[1]!.id,signalKind:'recurring_problem',quote:unresolved.text,needStatus:'unresolved',matchedCapabilityIds:[capabilityID]})];
  const result=aggregate([complaint,unresolved],obs,rows);
  const complaintEvidence=result.evidence.find(row=>row.sourceContentHash===complaint.contentHash)!;
  const unresolvedEvidence=result.evidence.find(row=>row.sourceContentHash===unresolved.contentHash)!;
  assert.equal(complaintEvidence.signalKind,'competitor_complaint');
  assert.equal(complaintEvidence.prospectStatus,'not_a_prospect');
  assert.equal(unresolvedEvidence.prospectStatus,'potential_fit');
  assert.equal(result.validObservations.length,2);
});
