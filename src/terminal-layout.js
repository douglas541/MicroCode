import { cellWidth } from "./picker.js";

const segmenter = new Intl.Segmenter(undefined, { granularity: "grapheme" });
const widthOf = (value) =>
  /\p{Emoji_Presentation}|\p{Regional_Indicator}|\ufe0f/u.test(value)
    ? 2
    : cellWidth(value);

export function displayWidth(text) {
  let width = 0;
  for (const { segment } of segmenter.segment(String(text)))
    width += widthOf(segment);
  return width;
}

export function terminalDimensions(output) {
  return {
    rows: Math.max(1, Math.floor(output.rows || 24)),
    columns: Math.max(1, Math.floor(output.columns || 100)),
  };
}

// Turn logical styled output into physical rows at the new width. Only SGR
// style sequences survive; cursor-control operations are never transcript data.
export function styledRows(text, columns) {
  const width = Math.max(1, columns);
  const result = [];
  let line = "";
  let size = 0;
  let style = "";
  const finish = () => {
    result.push(line + (style ? "\x1b[0m" : ""));
    line = style;
    size = 0;
  };
  const safe = String(text).replace(/\r\n?/g, "\n").replaceAll("\t", "    ");
  for (const token of safe.matchAll(
    /\x1b\[[\d;]*m|\x1b(?:\[[0-?]*[ -/]*[@-~]|\][^\x07]*(?:\x07|\x1b\\))|[^\x1b]+/g,
  )) {
    const value = token[0];
    if (value[0] === "\x1b") {
      if (/^\x1b\[[\d;]*m$/.test(value)) {
        line += value;
        style = /^\x1b\[(?:0)?m$/.test(value) ? "" : style + value;
      }
      continue;
    }
    for (const { segment } of segmenter.segment(value)) {
      if (segment === "\n") {
        finish();
        continue;
      }
      if (/[\x00-\x08\x0b-\x1f\x7f]/.test(segment)) continue;
      const glyph = widthOf(segment);
      if (size && size + glyph > width) finish();
      line += glyph > width ? "…" : segment;
      size += Math.min(glyph, width);
    }
  }
  if (line && (size || !result.length)) finish();
  return result;
}
