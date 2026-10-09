const ids = { codex: 'codex', deepseek: 'deepseek' };
export function mentionedAgents(text) {
  return [...new Set([...text.matchAll(/@(Codex|DeepSeek)(?![A-Za-z0-9_])/gi)].map(match => ids[match[1].toLowerCase()]))];
}
export function directedAgents(text) {
  let fence = null; const recipients = [];
  for (const line of text.split(/\r?\n/)) {
    const marker = line.match(/^\s*(`{3,}|~{3,})/);
    if (marker) { if (!fence) fence = marker[1][0]; else if (marker[1][0] === fence) fence = null; continue; }
    if (fence || /^\s*>/.test(line)) continue;
    const plain = line.replace(/`[^`]*`/g, '');
    const address = plain.match(/^\s*(?:[-*+]\s+|\d+[.)、]\s*)?(?:\*\*|__)?@(Codex|DeepSeek)(?![A-Za-z0-9_])/i);
    if (address) recipients.push(ids[address[1].toLowerCase()]);
  }
  return [...new Set(recipients)];
}
