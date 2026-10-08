import {load} from 'cheerio';
import {CollectionError} from './http.mjs';

const text = ($, element, max = 12_000) => {
  const copy = $(element).clone();
  copy.find('script, style, .post_flair, .author_flair').remove();
  copy.find('p, li, br, h1, h2, h3').append(' ');
  return copy.text().replace(/\s+/g, ' ').trim().slice(0, max);
};
const integer = value => /^\d+$/.test(value || '') ? Number(value) : null;
const timestamp = value => {
  const date = Date.parse(value || '');
  return Number.isFinite(date) ? new Date(date).toISOString() : null;
};

export function redlibPath(href, currentPath = '/search') {
  if (typeof href !== 'string') return null;
  try {
    const url = new URL(href.replace(/[\r\n\t]/g, '').trim(), `http://redlib.local${currentPath}`);
    if (url.origin !== 'http://redlib.local' || url.username || url.password) return null;
    if (!/^\/(?:search|r\/[\w]{2,21}(?:\/(?:search|new|hot|comments\/[a-z0-9]+\/[^/]*(?:\/[a-z0-9]+\/?)?))?\/?)(?:$)/i.test(url.pathname)) return null;
    url.hash = '';
    for (const [key, value] of url.searchParams) url.searchParams.set(key, value.trim());
    return url.pathname + url.search;
  } catch { return null; }
}

function permalink(path) {
  const match = path?.match(/^\/r\/([\w]{2,21})\/comments\/([a-z0-9]+)\/[^/?]*(?:\/([a-z0-9]+)\/?)?/i);
  if (!match) return null;
  return {subreddit: match[1], postId: match[2], commentId: match[3] || null,
    url: `https://www.reddit.com/r/${match[1]}/comments/${match[2]}/${match[3] ? `_/${match[3]}/` : ''}`};
}

/** Parses observed Redlib 0.36 markup. Unknown/error HTML is never an empty success. */
export function parseRedlib(html, {path, collectedAt = new Date().toISOString()} = {}) {
  const $ = load(html);
  if (!$('main').length || $('#error, .error, #challenge-form, form[action*="login"]').length ||
      /^(?:error|too many requests|access denied)/i.test($('title').text().trim())) throw new CollectionError('unrecognized_redlib_page');
  const postElements = $('main .post');
  const commentElements = $('main .comment');
  const isThread = Boolean(permalink(path));
  if (!postElements.length && !commentElements.length && !/no (?:posts|results|comments)(?: found)?/i.test($('main').text())) {
    throw new CollectionError('unrecognized_redlib_page');
  }
  const rows = [];
  postElements.each((_, element) => {
    const post = $(element);
    const href = post.find('.post_comments').attr('href') || post.find('.post_footer a[href*="/comments/"]').first().attr('href') || path;
    const collectionPath = redlibPath(href, path);
    const identity = permalink(collectionPath);
    const id = post.attr('id') || identity?.postId;
    if (!identity || identity.commentId || id !== identity.postId || !/^[a-z0-9]+$/i.test(id)) return;
    const author = text($, post.find('.post_author').first(), 120).replace(/^u\//, '');
    const snippet = text($, post.find('.post_body').first());
    if (author === '[deleted]' || ['[removed]', '[deleted]'].includes(snippet)) return;
    rows.push({source: 'Reddit', provider: 'redlib', sourceId: `t3_${id}`, postId: id, parentId: null, type: 'post',
      subreddit: identity.subreddit, url: identity.url, collectionPath, title: text($, post.find('.post_title').first(), 500),
      snippet, author: author || null, publishedAt: timestamp(post.find('.post_header .created').attr('title')),
      collectedAt, score: integer(post.find('.post_score').attr('title')),
      commentCount: integer((post.find('.post_comments').attr('title') || post.find('.post_footer p').text()).match(/\d+/)?.[0]),
      bodyStatus: post.find('.post_body').length ? 'available' : 'title_only'});
  });
  commentElements.each((_, element) => {
    const comment = $(element);
    // Direct-child selectors avoid attributing nested replies to a parent.
    const data = comment.children('.comment_right').children('.comment_data');
    const body = comment.children('.comment_right').children('.comment_body');
    const collectionPath = redlibPath(data.find('a.created').attr('href'), path);
    const identity = permalink(collectionPath);
    const id = comment.attr('id');
    if (!identity || identity.commentId !== id || !/^[a-z0-9]+$/i.test(id || '')) return;
    const author = text($, data.find('.comment_author'), 120).replace(/^u\//, '');
    const snippet = text($, body);
    if (!snippet || author === '[deleted]' || ['[removed]', '[deleted]'].includes(snippet)) return;
    const parent = comment.parents('.comment').first().attr('id');
    rows.push({source: 'Reddit', provider: 'redlib', sourceId: `t1_${id}`, postId: identity.postId, type: 'comment',
      parentId: parent ? `t1_${parent}` : isThread && !permalink(path)?.commentId ? `t3_${identity.postId}` : null,
      subreddit: identity.subreddit, url: identity.url, collectionPath,
      title: snippet.slice(0, 180), snippet, author: author || null,
      publishedAt: timestamp(data.find('.created').attr('title')), collectedAt,
      score: integer(comment.children('.comment_left').find('.comment_score').attr('title'))});
  });
  const continuations = [];
  $('main a').each((_, element) => {
    const link = $(element);
    if (!/^(?:next|load more|more comments|continue (?:this )?thread|view more)/i.test(link.text().trim()) && link.attr('accesskey') !== 'N') return;
    const next = redlibPath(link.attr('href'), path);
    if (!next || next === path) return;
    if (isThread && permalink(next)?.postId !== permalink(path)?.postId) return;
    if (!isThread && new URL(`http://redlib.local${next}`).pathname !== new URL(`http://redlib.local${path}`).pathname) return;
    continuations.push(next);
  });
  return {rows, continuations: [...new Set(continuations)], isThread,
    advertisedCommentCount: integer($('#comment_count').text().match(/\d+/)?.[0]) ?? rows.find(row => row.type === 'post')?.commentCount ?? null};
}
