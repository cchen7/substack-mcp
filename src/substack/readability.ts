import { JSDOM } from "jsdom";
import { Readability } from "@mozilla/readability";
import TurndownService from "turndown";

const turndown = new TurndownService({
  headingStyle: "atx",
  bulletListMarker: "-",
  codeBlockStyle: "fenced",
});

turndown.remove(["script", "style", "noscript", "iframe"]);

export function htmlToMarkdown(html: string, url: string): string {
  const normalizedHtml = html.trim().startsWith("<html")
    ? html
    : `<article>${html}</article>`;
  const dom = new JSDOM(normalizedHtml, { url });
  const article = new Readability(dom.window.document).parse();
  const content = article?.content ?? html;

  return turndown
    .turndown(content)
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}
