import {test} from 'node:test';
import assert from 'node:assert/strict';
import {conversationSource,redditDiscussionURL} from '../ui/src/source-context.mjs';

const comment={productId:'one',type:'comment',source:'Reddit',title:'A shortened comment title',snippet:'The complete comment.\n\nIt includes a qualification.',context:'Collection tracking\nOriginal post paragraph.\n\nSecond paragraph.',url:'https://www.reddit.com/r/sonnyangel/comments/abc123/collection_tracking/def456/?context=3#comment',author:'comment_author',publishedAt:'2026-02-23T12:00:00Z',qualification:{quote:'The complete comment.'}};

test('discussion context precedes the complete source without using an interpretation excerpt',()=>{
 const source=conversationSource(comment);
 assert.equal(source.discussion.title,'Collection tracking');
 assert.equal(source.discussion.body,'Original post paragraph.\n\nSecond paragraph.');
 assert.equal(source.body,comment.snippet);
 assert.equal(source.discussion.author,undefined);
 assert.equal(source.discussion.publishedAt,undefined);
});
test('a matching saved post supplies its own attribution and text, scoped to the product',()=>{
 const other={productId:'two',type:'post',url:'https://www.reddit.com/r/sonnyangel/comments/abc123/',title:'Wrong product record',snippet:'Other product record'};
 const parent={...other,productId:'one',title:'Original discussion title',snippet:'Saved original post text.',author:'post_author',publishedAt:'2026-02-20T12:00:00Z'};
 const source=conversationSource(comment,[other,parent]);
 assert.equal(source.discussion.title,parent.title);assert.equal(source.discussion.body,parent.snippet);
 assert.equal(source.discussion.author,parent.author);assert.equal(source.discussion.publishedAt,parent.publishedAt);
 assert.equal(source.body,comment.snippet);
});
test('title-only and missing context retain an explicit empty post body',()=>{
 assert.equal(conversationSource({...comment,context:'Collection tracking'}).discussion.body,'');
 const source=conversationSource({...comment,context:null});
 assert.equal(source.discussion.title,'Original discussion');assert.equal(source.discussion.body,'');
 assert.equal(source.discussion.author,undefined);
});
test('discussion links remove the comment id, query and fragment without inventing another source',()=>{
 assert.equal(redditDiscussionURL(comment.url),'https://www.reddit.com/r/sonnyangel/comments/abc123/');
 assert.equal(redditDiscussionURL('https://old.reddit.com/comments/abc123/title/commentid/'),'https://www.reddit.com/comments/abc123/');
 for(const url of ['https://user:secret@www.reddit.com/r/x/comments/abc123/','https://reddit.com.evil.test/r/x/comments/abc123/','javascript:alert(1)','https://example.com/comments/abc123/','https://www.reddit.com/r/sonnyangel/'])assert.equal(redditDiscussionURL(url),undefined);
});
test('posts keep their own title and body; a title-only post is not repeated as its body',()=>{
 const post={...comment,type:'post',title:'Original post title',snippet:'Original post text.'};
 const source=conversationSource(post);
 assert.equal(source.isComment,false);assert.equal(source.discussion.title,post.title);assert.equal(source.body,post.snippet);
 assert.equal(conversationSource({...post,snippet:post.title}).body,'');
});

test('old and current Reddit permalinks resolve to the same saved parent discussion',()=>{
 const parent={productId:'one',type:'post',url:'https://www.reddit.com/r/sonnyangel/comments/abc123/title/',title:'Saved parent',snippet:'The original post body.'};
 const source=conversationSource({...comment,url:comment.url.replace('www.reddit.com','old.reddit.com')},[parent]);
 assert.equal(source.discussion.title,'Saved parent');assert.equal(source.discussion.body,parent.snippet);
});
