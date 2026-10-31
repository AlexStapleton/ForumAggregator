/** Only explicit same-thread permalinks can become local jumps. Post-only redirects stay external. */
export function quotedPostId(reference: string, thread: string): string | null {
  try {
    const ref = new URL(reference);
    const base = new URL(thread);
    if (!/^https?:$/.test(ref.protocol) || ref.origin !== base.origin) return null;
    const identity = (url: URL) => {
      const xf = /^(.*\/threads\/)[^/]+\.(\d+)(?:\/(?:page-\d+|latest)?)?\/?$/.exec(url.pathname);
      if (xf) return `${xf[1]}${xf[2]}`;
      if (/\/showthread\.php$/.test(url.pathname) && /^\d+$/.test(url.searchParams.get("t") ?? ""))
        return `${url.pathname}?t=${url.searchParams.get("t")}`;
      const vb = /^(.*\/)(\d+)-(.+?)(?:-\d+)?\.html$/.exec(url.pathname);
      return vb ? `${vb[1]}${vb[2]}` : null;
    };
    const key = identity(base);
    if (!key || identity(ref) !== key) return null;
    const id = /^#post-?(\d+)$/.exec(ref.hash)?.[1] ?? ref.searchParams.get("p");
    return id && /^[1-9]\d*$/.test(id) && Number.isSafeInteger(Number(id)) ? id : null;
  } catch { return null; }
}

/** DOM enhancement preserves readable quotes if scripting is unavailable. State lives in the
 * mounted quote, so appending a page does not reset expanded quotes or duplicate controls. */
export function enhanceQuotes(root: HTMLElement, thread: string) {
  const doc = root.ownerDocument;
  const win = doc.defaultView!;
  const known = new WeakSet<Element>();
  let returnTo: HTMLElement | null = null;
  let highlighted: HTMLElement | null = null;
  let returnTop = 0;
  const bar = doc.createElement("div");
  bar.className = "quote-return";
  bar.hidden = true;
  const back = doc.createElement("button");
  back.type = "button";
  back.textContent = "Return to reply";
  bar.append(back, " — reading position paused while viewing a quote");
  root.prepend(bar);
  const pause = (mode: "jump" | "layout") => { root.dataset.quotePause = mode; };
  const move = (target: HTMLElement) => {
    root.scrollTop += target.getBoundingClientRect().top - root.getBoundingClientRect().top - bar.getBoundingClientRect().height - 16;
    target.focus({ preventScroll: true });
  };
  back.onclick = () => {
    pause("layout");
    highlighted?.classList.remove("quote-target");
    bar.hidden = true;
    if (returnTo?.isConnected) {
      root.scrollTop = returnTop;
      returnTo.focus({ preventScroll: true });
    }
    returnTo = null;
  };
  const resize = typeof win.ResizeObserver === "function" ? new win.ResizeObserver(() => measure()) : null;
  const anchor = () => {
    const top = root.getBoundingClientRect().top;
    const post = Array.from(root.querySelectorAll<HTMLElement>(".reader-content > section[id^='fa-post-']"))
      .find((el) => el.getBoundingClientRect().top >= top);
    const before = post?.getBoundingClientRect().top;
    return () => { if (post?.isConnected && before !== undefined) root.scrollTop += post.getBoundingClientRect().top - before; };
  };
  const measure = () => {
    const restore = anchor();
    for (const quote of Array.from(root.querySelectorAll<HTMLElement>("blockquote[data-quote-ready]"))) {
      if (quote.querySelector(":scope > details")) continue;
      const line = parseFloat(win.getComputedStyle(quote).lineHeight) || 24;
      if (quote.getBoundingClientRect().height <= line * 12) continue;
      // Keep attribution visible; native details supports keyboard and assistive technology.
      const details = doc.createElement("details");
      const summary = doc.createElement("summary");
      summary.textContent = "Quoted text (expand or collapse)";
      const head = Array.from(quote.children).find((el) => el.tagName === "P" && el.querySelector(":scope > cite"));
      details.append(summary);
      for (const child of Array.from(quote.childNodes)) {
        if (child !== head && !(child.nodeType === 1 && (child as Element).matches(".quote-jump"))) details.append(child);
      }
      if (!root.dataset.quotePause) pause("layout");
      quote.append(details);
      resize?.unobserve(quote);
    }
    restore();
  };
  const decorate = () => {
    for (const quote of Array.from(root.querySelectorAll<HTMLElement>(".reader-content blockquote"))) {
      if (known.has(quote)) continue;
      known.add(quote);
      quote.dataset.quoteReady = "true";
      const reference = quote.getAttribute("cite");
      const id = reference && quotedPostId(reference, thread);
      if (id) {
        const button = doc.createElement("button");
        button.type = "button";
        button.className = "quote-jump link";
        button.dataset.quotePost = id;
        button.textContent = "Jump to quoted post";
        quote.prepend(button);
      }
      resize?.observe(quote);
    }
    // A previously unloaded target may have arrived in an appended page.
    for (const button of Array.from(root.querySelectorAll<HTMLButtonElement>("button[data-quote-post]"))) {
      button.hidden = !root.querySelector(`.reader-content > section#fa-post-${button.dataset.quotePost}`);
    }
    measure();
  };
  const click = (event: Event) => {
    const target = event.target as Element;
    const summary = target.closest("blockquote > details > summary");
    if (summary) {
      if (root.dataset.quotePause !== "jump") pause("layout");
      const restore = anchor();
      win.requestAnimationFrame(restore);
      return;
    }
    const button = target.closest<HTMLButtonElement>("button[data-quote-post]");
    if (!button) return;
    const post = root.querySelector<HTMLElement>(`.reader-content > section#fa-post-${button.dataset.quotePost}`);
    if (!post) return;
    pause("jump");
    if (!returnTo) { returnTo = button; returnTop = root.scrollTop; }
    highlighted?.classList.remove("quote-target");
    highlighted = post;
    post.classList.add("quote-target");
    post.tabIndex = -1;
    bar.hidden = false;
    move(post);
  };
  // Layout changes cannot save progress until a deliberate reading gesture. Quote excursions
  // remain paused until Return to reply, even if the reader scrolls while inspecting the quote.
  const resume = (event: Event) => {
    if (root.dataset.quotePause !== "layout") return;
    if (event.type === "keydown" && !["ArrowDown", "ArrowUp", "PageDown", "PageUp", " ", "Home", "End"].includes((event as KeyboardEvent).key)) return;
    if ((event.target as Element)?.closest?.("button, summary, input, select, textarea")) return;
    delete root.dataset.quotePause;
  };
  const observer = new win.MutationObserver(decorate);
  observer.observe(root, { childList: true, subtree: true });
  root.addEventListener("click", click);
  root.addEventListener("wheel", resume, { passive: true });
  root.addEventListener("touchmove", resume, { passive: true });
  root.addEventListener("keydown", resume);
  root.addEventListener("load", measure, true);
  decorate();
  return () => {
    observer.disconnect();
    resize?.disconnect();
    root.removeEventListener("click", click);
    root.removeEventListener("wheel", resume);
    root.removeEventListener("touchmove", resume);
    root.removeEventListener("keydown", resume);
    root.removeEventListener("load", measure, true);
    bar.remove();
    for (const button of Array.from(root.querySelectorAll(".quote-jump"))) button.remove();
    for (const quote of Array.from(root.querySelectorAll("blockquote[data-quote-ready]"))) {
      const details = quote.querySelector(":scope > details");
      details?.querySelector(":scope > summary")?.remove();
      if (details) details.replaceWith(...Array.from(details.childNodes));
      quote.removeAttribute("data-quote-ready");
    }
    highlighted?.classList.remove("quote-target");
    delete root.dataset.quotePause;
  };
}
