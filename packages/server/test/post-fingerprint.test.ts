import { describe, expect, it } from "vitest";
import { postFingerprint } from "../src/reader/postFingerprint.js";

describe("post semantic fingerprints", () => {
  it("ignores cosmetic attributes and attribute ordering", () => {
    expect(postFingerprint('<p class="old"><a href="https://example.test/a?id=1" title="File">File</a></p>'))
      .toBe(postFingerprint('<p class="new" data-ui="selected"><a title="File" href="https://example.test/a?id=1">File</a></p>'));
  });
  it.each([
    ['<p>1.2 volts</p>', '<p>1.3 volts</p>'],
    ['<pre>  x\n y</pre>', '<pre> x\n y</pre>'],
    ['<blockquote>yes</blockquote>', '<blockquote>no</blockquote>'],
    ['<table><tr><td>10</td></tr></table>', '<table><tr><td>20</td></tr></table>'],
    ['<img src="https://example.test/file?id=1">', '<img src="https://example.test/file?id=2">'],
  ])("preserves meaningful changes in %s", (before, after) => {
    expect(postFingerprint(before)).not.toBe(postFingerprint(after));
  });
});
