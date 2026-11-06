// Forum content that the sanitizer's allow-list used to delete without a trace (D-139, D-140, D-141).
import { describe, expect, it } from "vitest";
import { inspectThreadPage } from "../src/feeds/thread.js";
import { sanitizeHtml } from "../src/reader/sanitize.js";
import { postFingerprint } from "../src/reader/postFingerprint.js";

const BASE = "https://forum.example/threads/t.1/";
const xfPost = (id: number, html: string) =>
  `<article class="message message--post js-post" data-author="A${id}" data-content="post-${id}" id="js-post-${id}"><div class="message-body"><div class="bbWrapper">${html}</div></div></article>`;
const xfPage = (...posts: string[]) => `<html><head><title>T</title></head><body><h1 class="p-title-value">T</h1>${posts.join("")}</body></html>`;
const readXf = (html: string) => {
  const result = inspectThreadPage(xfPage(xfPost(1, html)), BASE);
  expect(result.status).toBe("complete");
  return result.value!.posts[0]!.html;
};

describe("embeds become links instead of vanishing", () => {
  it("XenForo media BB code (YouTube) shows a thumbnail linking to the video", () => {
    const html = readXf(`<div class="bbMediaWrapper" data-media-site-id="youtube" data-media-key="dQw4w9WgXcQ"><div class="bbMediaWrapper-inner"><iframe src="https://www.youtube.com/embed/dQw4w9WgXcQ?wmode=opaque"></iframe></div></div>`);
    expect(html).toContain('href="https://www.youtube.com/watch?v=dQw4w9WgXcQ"');
    expect(html).toContain('src="https://i.ytimg.com/vi/dQw4w9WgXcQ/hqdefault.jpg"');
    expect(html).not.toContain("<iframe");
  });

  it("s9e MediaEmbed: YouTube from the player address, X from the key after '#'", () => {
    expect(readXf(`<span data-s9e-mediaembed="youtube"><span><iframe src="https://www.youtube.com/embed/abcDEF12345"></iframe></span></span>`))
      .toContain("https://www.youtube.com/watch?v=abcDEF12345");
    expect(readXf(`<span data-s9e-mediaembed="twitter"><iframe data-s9e-mediaembed-src="https://s9e.github.io/iframe/2/twitter.min.html#1234567890" src="about:blank"></iframe></span>`))
      .toContain('href="https://x.com/i/status/1234567890"');
  });

  it("an unknown player links to its address; one without an address leaves a note", () => {
    expect(readXf(`text <iframe src="https://maps.example.org/embed?q=1"></iframe>`)).toContain('href="https://maps.example.org/embed?q=1"');
    expect(readXf(`text <iframe src="about:blank"></iframe>`)).toContain("[Embedded content not shown]");
  });

  it("an https video file plays, with a link; an http one is a link only", () => {
    const https = readXf(`<video controls><source src="https://forum.example/data/video/1.mp4" type="video/mp4"></video>`);
    expect(https).toMatch(/<video src="https:\/\/forum\.example\/data\/video\/1\.mp4" controls="" preload="metadata"><\/video>/);
    expect(https.match(/Open the video/g)).toHaveLength(1); // the parser and the sanitizer both run it
    const http = readXf(`<video src="http://cdn.example/clip.mp4"></video>`);
    expect(http).not.toContain("<video");
    expect(http).toContain('href="http://cdn.example/clip.mp4"');
  });

  it("feeds and articles get the same treatment (one sanitizer)", () => {
    const html = sanitizeHtml(`<p>Watch:</p><iframe src="https://www.youtube-nocookie.com/embed/abcDEF12345"></iframe>`, "https://blog.example/post");
    expect(html).toContain("https://www.youtube.com/watch?v=abcDEF12345");
  });
});

describe("posts that are only a video or an http:// image", () => {
  it("no longer make the whole page count as misread (the thread kept checking otherwise)", () => {
    for (const only of [
      `<div class="bbMediaWrapper"><iframe src="https://www.youtube.com/embed/abcDEF12345"></iframe></div>`,
      `<img src="http://i.example.com/p.jpg" class="bbImage">`,
    ]) {
      const result = inspectThreadPage(xfPage(xfPost(1, "hello"), xfPost(2, only), xfPost(3, "bye")), BASE);
      expect(result.status).toBe("complete");
      expect(result.value!.posts).toHaveLength(3);
    }
  });
});

describe("http:// images", () => {
  it("are loaded through this server instead of being dropped", () => {
    expect(readXf(`<img src="http://i.example.com/photo.jpg" alt="photo">`)).toContain('src="/api/image?url=http%3A%2F%2Fi.example.com%2Fphoto.jpg"');
  });

  it("a lazy image whose only real address is http:// is used over its placeholder", () => {
    expect(readXf(`<img src="data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP" data-src="http://i.example.com/lazy.jpg" class="bbImage">`))
      .toContain("/api/image?url=http%3A%2F%2Fi.example.com%2Flazy.jpg");
  });

  it("https images are untouched, and sanitizing twice keeps the proxy address", () => {
    expect(readXf(`<img src="https://i.example.com/a.jpg">`)).toContain('src="https://i.example.com/a.jpg"');
    const once = sanitizeHtml(`<img src="http://i.example.com/a.jpg">`, BASE);
    expect(sanitizeHtml(once, BASE)).toBe(once);
  });

  it("a forged proxy link to anything but http:// is not kept as a proxy link", () => {
    expect(sanitizeHtml(`<img src="/api/image?url=https%3A%2F%2Fx.example%2Fa.jpg">`, BASE)).toContain('src="https://forum.example/api/image?url=');
  });
});

describe("spoilers and smilies", () => {
  it("a XenForo spoiler is click to reveal, with its title", () => {
    const html = readXf(`<div class="bbCodeSpoiler"><button class="bbCodeSpoiler-button button"><span class="button-text"><span>Spoiler</span><span class="bbCodeSpoiler-button-title">Ending</span></span></button><div class="bbCodeSpoiler-content"><div class="bbCodeBlock bbCodeBlock--spoiler"><div class="bbCodeBlock-content">He wins.</div></div></div></div>`);
    expect(html).toBe("<details><summary>Spoiler: Ending</summary>He wins.</details>");
  });

  it("sprite smilies keep their text; emoji pictures stay pictures", () => {
    expect(readXf(`Nice <img src="data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP" class="smilie smilie--sprite smilie--sprite1" alt=":)" title="Smile :)"> done`)).toBe("Nice :) done");
    expect(readXf(`<img class="smilie smilie--emoji" src="https://cdn.example/1f600.png" alt="😀">`)).toContain('src="https://cdn.example/1f600.png"');
  });
});

describe("vBulletin attachments beside the message", () => {
  const vbPage = (post: string, generator = "vBulletin 3.9") =>
    `<html><head><title>T</title><meta name="generator" content="${generator}"></head><body>${post}</body></html>`;

  it("vB3: attached thumbnails show the full picture; attached files are links", () => {
    const page = vbPage(`<div id="post10"><table><tr><td class="thead">10-23-26, 12:23 AM</td></tr><tr><td><a class="bigusername" href="/m">U</a></td>
      <td id="td_post_10"><div id="post_message_10">Look at this</div>
      <fieldset class="fieldset"><legend>Attached Thumbnails</legend><a href="attachment.php?attachmentid=55&amp;d=1" rel="Lightbox_10"><img class="thumbnail" src="attachment.php?attachmentid=55&amp;stc=1&amp;thumb=1&amp;d=1" title="Name: frame.jpg Views: 12 Size: 80 KB"></a></fieldset>
      <fieldset class="fieldset"><legend>Attached Files</legend><img class="inlineimg" src="images/attach/pdf.gif"> <a href="attachment.php?attachmentid=56&amp;d=1">manual.pdf</a> (12 KB)</fieldset>
      <div class="signature">__________________<br><a href="attachment.php?attachmentid=99&amp;d=1">sig.png</a></div>
      </td></tr></table></div>`);
    const html = inspectThreadPage(page, "https://forum.example/showthread.php?t=1").value!.posts[0]!.html;
    expect(html).toContain('<img src="https://forum.example/attachment.php?attachmentid=55&amp;d=1" alt="frame.jpg"');
    expect(html).toContain("<figcaption>frame.jpg</figcaption>");
    expect(html).toContain('href="https://forum.example/attachment.php?attachmentid=56&amp;d=1"');
    expect(html).toContain(">manual.pdf</a>");
    expect(html).not.toContain("attachmentid=99"); // signatures stay out
    expect(html).not.toContain("pdf.gif");
  });

  it("vB4: the .attachments box, and an upload already in the message isn't repeated", () => {
    const page = vbPage(`<ol id="posts"><li class="postbitlegacy" id="post_20"><div class="posthead"><span class="postdate"><span class="date">10-23-2026, 12:23 AM</span></span></div>
      <div class="userinfo"><a class="username" href="m">U</a></div><div class="postbody"><div class="content">
      <div id="post_message_20"><blockquote class="postcontent restore">Here <a href="attachment.php?attachmentid=76&amp;d=1"><img src="attachment.php?attachmentid=76&amp;thumb=1"></a></blockquote></div></div>
      <div class="attachments"><fieldset class="postcontent"><legend>Attached Images</legend><ul>
      <li><a href="attachment.php?attachmentid=76&amp;d=1"><img class="thumbnail" src="attachment.php?attachmentid=76&amp;thumb=1"></a></li>
      <li><a href="attachment.php?attachmentid=77&amp;d=1"><img class="thumbnail" src="attachment.php?attachmentid=77&amp;thumb=1"></a></li></ul></fieldset></div>
      </div></li></ol>`, "vBulletin 4.2.5");
    const html = inspectThreadPage(page, "https://forum.example/showthread.php?t=2").value!.posts[0]!.html;
    expect(html.match(/attachmentid=76&amp;d=1/g)).toHaveLength(1);
    expect(html).toContain('<img src="https://forum.example/attachment.php?attachmentid=77&amp;d=1"');
  });
});

describe("edit detection across a change in how posts are shown", () => {
  it("fingerprints carry a version, so posts re-shown differently aren't marked edited", () => {
    expect(postFingerprint("<p>x</p>")).toMatch(/^v2:[0-9a-f]{64}$/);
  });
});
