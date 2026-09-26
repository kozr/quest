import {test} from 'node:test';
import assert from 'node:assert/strict';
import {OpenAIResponsesLeadAIProvider} from '../src/leads-ai.js';
import {LEAD_REPLY_PROMPT,MAX_REPLY_OUTPUT,leadReplyPlanSchema} from '../src/lead-replies.js';
import type {LeadProfile} from '../src/leads-types.js';

import {replyFixture} from './lead-reply-fixture.js';

const profile={problems:[{text:'Track a collection'}],capabilities:[{text:'Track owned figures',source:'user_confirmed'}]} as LeadProfile;
test('reply request uses the approved help-first prompt, confirmed context and bounded structured output',async()=>{
  let sent:any;
  const provider=new OpenAIResponsesLeadAIProvider('fixture','gpt-6-luna',(async(_url,init)=>{
    sent=JSON.parse(String(init?.body));
    return new Response(JSON.stringify({model:'gpt-6-luna',status:'completed',output_text:JSON.stringify(replyFixture),usage:{input_tokens:100,output_tokens:220}}));
  }) as typeof fetch);
  assert.deepEqual((await provider.draftReplies({title:'How do I track figures?',body:'I buy duplicates.',subreddit:'actionfigures'},profile,'Figure Shelf')).value,replyFixture);
  assert.equal(sent.input[0].content,LEAD_REPLY_PROMPT);
  const context=JSON.parse(sent.input[1].content);
  assert.deepEqual(context.capabilities,['Track owned figures']);
  assert.deepEqual(context.comments,[]);assert.deepEqual(context.alternativeResources,[]);
  assert.equal(sent.max_output_tokens,MAX_REPLY_OUTPUT);assert.equal(sent.store,false);
  assert.equal(sent.text.format.schema.properties.replies.minItems,2);
});
test('malformed or repeated reply approaches never become usable drafts',()=>{
  assert.equal(leadReplyPlanSchema.safeParse({...replyFixture,replies:[replyFixture.replies[0]]}).success,false);
  assert.equal(leadReplyPlanSchema.safeParse({...replyFixture,replies:[replyFixture.replies[0],{...replyFixture.replies[0],id:'light'}]}).success,false);
  for(const body of ['Can you DM me?', 'Try https://invented.example/', '<script>alert(1)</script>']) {
    assert.equal(leadReplyPlanSchema.safeParse({...replyFixture,replies:[replyFixture.replies[0],{...replyFixture.replies[1],body}]}).success,false);
  }
});
