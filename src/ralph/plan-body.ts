// The plan text of a ralplan artifact: no YAML frontmatter and, for old
// artifacts that embedded the review history, nothing from `## Review
// history` onward (plus the `---` rule that preceded it).
export const planBody = (markdown: string): string => {
  let text = markdown.replace(/\r\n/g, '\n');
  text = text.replace(/^---\n[\s\S]*?\n---[ \t]*(?:\n|$)/, '');
  const history = text.search(/^## Review history[ \t]*$/m);
  if (history >= 0) {
    text = text.slice(0, history).replace(/\n---[ \t]*\n*$/, '\n');
  }
  return text.trim();
};
