// Pure Markdown renderers extracted from @dtconcepts/timds 0.1.464 src/extract.mjs.
// Original copyright (c) 2026 DT Concepts; MIT notice follows.
/*
MIT License

Copyright (c) 2026 DT Concepts

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.

*/
export function blockToMarkdown(block) {
  const lines = [];
  const anchor = block.id.includes("#") ? block.id.slice(block.id.indexOf("#") + 1) : block.id;
  lines.push(`## ${block.title || anchor}   \`#${anchor}\``, "");
  if (block.intro) lines.push(block.intro, "");
  for (const table of block.specs ?? []) {
    const columns = table.columns.length ? table.columns : Object.keys(table.rows[0].fields);
    lines.push(`| ${columns.join(" | ")} |`, `| ${columns.map(() => "---").join(" | ")} |`);
    for (const row of table.rows) {
      const source = row.markdown ?? row.fields;
      lines.push(`| ${columns.map((column) => String(source[column] ?? "").replace(/\|/g, "\\|")).join(" | ")} |`);
    }
    lines.push("");
  }
  for (const note of block.notes ?? []) lines.push(`> **Note.** ${note.text}`, "");
  for (const entry of block.code ?? []) lines.push("```", entry.text, "```", "");
  if (block.assets?.length) {
    lines.push("| Asset | Media key | Notes |", "| --- | --- | --- |");
    for (const asset of block.assets) {
      const brand = asset.brand
        ? [asset.brand.role, asset.brand.primary ? "primary" : null, asset.brand.variant, asset.brand.lockup, asset.brand.on ? `on ${asset.brand.on}` : null].filter(Boolean).join(" ")
        : null;
      const detail = [brand ? `**${brand}**` : null, ...(asset.lines ?? [])].filter(Boolean).join(" · ").replace(/\|/g, "\\|");
      lines.push(`| ${asset.name} | \`${asset.media.key ?? "—"}\` | ${detail} |`);
    }
    lines.push("");
  }
  for (const entry of block.prose ?? []) lines.push(entry.text, "");
  return `${lines.join("\n").replace(/\n{3,}/g, "\n\n").trimEnd()}\n`;
}

export function pageToMarkdown(page) {
  const lines = [`# ${page.title || page.id}`, ""];
  if (page.eyebrow) lines.push(`*${page.eyebrow}*`, "");
  if (page.lede) lines.push(page.lede, "");
  lines.push(`<!-- source: ${page.url} · id: ${page.id} -->`, "");
  for (const block of page.blocks) lines.push(blockToMarkdown(block));
  return `${lines.join("\n").replace(/\n{3,}/g, "\n\n").trimEnd()}\n`;
}

