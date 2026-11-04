/** HTML to readable text, through html-to-text (an htmlparser2-based parser). */
import { convert } from "html-to-text";

export function htmlToText(html: string): string {
  return convert(html, {
    wordwrap: false,
    selectors: [
      { selector: "script", format: "skip" },
      { selector: "style", format: "skip" },
      { selector: "noscript", format: "skip" },
      { selector: "img", format: "skip" },
      { selector: "a", options: { ignoreHref: false, linkBrackets: false } },
    ],
  });
}
