/**
 * cleanForTts(text) — strip everything a voice should not read aloud.
 *
 * Claude Face's brain (Claude) replies in normal prose, which can carry markdown, code,
 * box-drawing, emoji, and symbols. HeadTTS would otherwise read "asterisk asterisk" or
 * spell out glyphs. This collapses a reply to clean spoken text. Written fresh from the
 * V0.6 spec's described regex set (the clawd-face source is not on this machine).
 * Pure function, no deps — unit-testable via `node bridge/cleanForTts.mjs --selftest`.
 */

// emoji, pictographs, dingbats, arrows, variation selectors, ZWJ
const EMOJI = /[\u{1F000}-\u{1FAFF}\u{2600}-\u{27BF}\u{2B00}-\u{2BFF}\u{2190}-\u{21FF}\u{FE00}-\u{FE0F}\u{200D}\u{20E3}\u{2122}\u{2139}]/gu;
// box-drawing, block elements, geometric shapes (used in ASCII tables/diagrams)
const BOX = /[─-╿▀-▟■-◿]/g;

export function cleanForTts(input) {
  if (input == null) return "";
  let s = String(input);

  // fenced code blocks -> drop entirely (never read code aloud)
  s = s.replace(/```[\s\S]*?```/g, " ");
  s = s.replace(/~~~[\s\S]*?~~~/g, " ");
  // inline code -> keep the words, drop the backticks
  s = s.replace(/`([^`]*)`/g, "$1");

  // images ![alt](url) -> alt ; links [text](url) -> text ; bare autolinks dropped
  s = s.replace(/!\[([^\]]*)\]\([^)]*\)/g, "$1");
  s = s.replace(/\[([^\]]+)\]\([^)]*\)/g, "$1");
  s = s.replace(/<https?:\/\/[^>]+>/g, " ");

  // markdown tables: drop separator-only rows, then turn pipes into pauses
  s = s.replace(/^\s*\|?[\s:|-]+\|?\s*$/gm, " ");
  s = s.replace(/\s*\|\s*/g, " ");

  // line-start structure: headings, blockquotes, bullets, ordered lists, rules
  s = s.replace(/^\s{0,3}#{1,6}\s+/gm, "");
  s = s.replace(/^\s{0,3}>\s?/gm, "");
  s = s.replace(/^\s*[-*+]\s+/gm, "");
  s = s.replace(/^\s*\d+[.)]\s+/gm, "");
  s = s.replace(/^\s*([-*_])\1{2,}\s*$/gm, " ");

  // emphasis: strip the markers, keep the words
  s = s.replace(/(\*\*|__)(.*?)\1/g, "$2");
  s = s.replace(/(\*|_)(.*?)\1/g, "$2");
  s = s.replace(/~~(.*?)~~/g, "$1");

  // diagrams / decoration / emoji
  s = s.replace(BOX, " ");
  s = s.replace(EMOJI, " ");

  // spoken-friendly swaps
  s = s.replace(/&/g, " and ");
  s = s.replace(/[•·▪◦]/g, " ");
  s = s.replace(/\.\.\.|…/g, "… ");

  // any leftover markdown punctuation that reads badly
  s = s.replace(/[#*_`>~|]/g, " ");

  // tidy whitespace and spacing around punctuation
  s = s.replace(/[ \t]+/g, " ");
  s = s.replace(/[ \t]*\n[ \t]*/g, "\n");
  s = s.replace(/\n{2,}/g, "\n");
  s = s.replace(/ +([,.!?;:])/g, "$1");
  s = s.replace(/[ \t]*\n[ \t]*/g, " ");
  return s.trim();
}

// quick self-test: node bridge/cleanForTts.mjs --selftest
if (process.argv[1] && process.argv[1].endsWith("cleanForTts.mjs") && process.argv.includes("--selftest")) {
  const cases = [
    ["**Hello** there, here is a `value` and a [link](http://x.com).", "Hello there, here is a value and a link."],
    ["# Heading\n- one\n- two", "Heading one two"],
    ["Use ```\ncode\n``` then talk.", "Use then talk."],
    ["Brilliant! \u{1F389} Shall we begin?", "Brilliant! Shall we begin?"],
    ["Tom & Jerry", "Tom and Jerry"],
    ["Plain sentence, nothing to strip.", "Plain sentence, nothing to strip."],
  ];
  let pass = 0;
  for (const [inp, want] of cases) {
    const got = cleanForTts(inp);
    const ok = got === want;
    pass += ok ? 1 : 0;
    console.log(`${ok ? "PASS" : "FAIL"}  got=${JSON.stringify(got)}${ok ? "" : `  want=${JSON.stringify(want)}`}`);
  }
  console.log(`\n${pass}/${cases.length} passed`);
  process.exit(pass === cases.length ? 0 : 1);
}
