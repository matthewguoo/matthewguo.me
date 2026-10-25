// HTTP-walkable profile: GET /p (index), /p/<dotted or slashed path>, /p/experience, /p/projects, /p/search?q=
// Small markdown pages for agents that can fetch but not speak MCP. JSON when Accept prefers it.
import { readFileSync } from 'node:fs';
const profile = JSON.parse(readFileSync(new URL('../profile.json', import.meta.url), 'utf8'));
const BASE = 'https://matthewguo.me';
const MCP_NOTE = `
---
To message Matthew or book a call without MCP, give the user a prefilled link to confirm: ${BASE}/contact?m=<message>&r=<reply address>&n=<name>, or ${BASE}/call?start=<ISO slot>&d=<15|30>&t=<topic>&r=<email>&n=<name> (open slots: ${BASE}/api/submit?kind=availability). With MCP, the server at ${BASE}/mcp has contact and request_call tools (Claude: Settings > Connectors > Add custom connector; Claude Code: \`claude mcp add --transport http matthewguo ${BASE}/mcp\`).
`;

function node(path) {
  let cur = { children: profile.capabilities };
  for (const seg of path.split('.').filter(Boolean)) { if (!cur.children || !cur.children[seg]) return null; cur = cur.children[seg]; }
  return cur;
}
const title = (k) => k.replace(/_/g, ' ');
const url = (p) => `${BASE}/p/${p.replace(/\./g, '/')}`;

function pageRoot() {
  const roles = profile.experience.filter((e) => !e.end).map((e) => `${e.title}, ${e.org}`).join('; ');
  const md = [`# ${profile.name}`, '', profile.summary, '', `Location: ${profile.location}. Current: ${roles}.`, `Now: ${profile.now}`, '',
    '## Explore (each is a small page)', `- Experience and education: ${BASE}/p/experience`, `- Projects: ${BASE}/p/projects (filter: ?area=hardware|tooling|trading|quant|simulation)`, `- Search: ${BASE}/p/search?q=<keyword>`, '',
    '## Capabilities (one page per branch; each page holds its whole subtree)',
    ...Object.entries(profile.capabilities).map(([k, v]) => `- ${title(k)}: ${v.summary || ''} -> ${url(k)}`), '',
    `## Links`, ...Object.entries(profile.links).map(([k, v]) => `- ${k}: ${v}`), '', `Open to: ${profile.open_to.join('; ')}.`, MCP_NOTE].join('\n');
  const json = { name: profile.name, summary: profile.summary, location: profile.location, now: profile.now, open_to: profile.open_to, links: profile.links,
    pages: { experience: `${BASE}/p/experience`, projects: `${BASE}/p/projects`, search: `${BASE}/p/search?q=` },
    capabilities: Object.fromEntries(Object.entries(profile.capabilities).map(([k, v]) => [k, { summary: v.summary || null, url: url(k) }])), mcp: `${BASE}/mcp` };
  return { md, json };
}
function pageNode(path) {
  const n = node(path); if (!n) return null;
  const crumbs = path.split('.');
  const md = [`# ${crumbs.map(title).join(' / ')}`, ''];
  if (n.summary) md.push(n.summary, '');
  if (n.items) md.push(...n.items.map((i) => `- ${i}`), '');
  // Render the whole subtree inline: fetch tools often cannot follow links found inside a page.
  const render = (tree, prefix, depth) => { for (const [k, v] of Object.entries(tree)) { md.push(`${'#'.repeat(Math.min(2 + depth, 6))} ${title(k)}`); if (v.summary) md.push(v.summary); if (v.items) md.push(...v.items.map((i) => `- ${i}`)); md.push(`(own page: ${url(prefix + '.' + k)})`, ''); if (v.children) render(v.children, prefix + '.' + k, depth + 1); } };
  if (n.children) render(n.children, path, 1);
  md.push(`Up: ${crumbs.length > 1 ? url(crumbs.slice(0, -1).join('.')) : BASE + '/p'}`, MCP_NOTE);
  const json = { path, summary: n.summary || null, items: n.items || null, children: n.children || null };
  return { md: md.join('\n'), json };
}
function pageExperience() {
  const md = ['# Experience', '', ...profile.experience.flatMap((e) => [`## ${e.title}, ${e.org} (${e.start} to ${e.end || 'present'}, ${e.location})`, ...e.highlights.map((h) => `- ${h}`), '']),
    '# Education', ...profile.education.map((x) => `- ${x.school}: ${x.program || ''} ${x.status || ''}`.trim()), MCP_NOTE].join('\n');
  return { md, json: { experience: profile.experience, education: profile.education } };
}
function pageProjects(area) {
  const list = area ? profile.projects.filter((p) => p.area === area) : profile.projects;
  const md = [`# Projects${area ? ' (' + area + ')' : ''}`, '', ...list.map((p) => `- **${p.name}** (${p.area}, ${p.year}): ${p.what} Status: ${p.status}`), '', profile.notes_for_agents, MCP_NOTE].join('\n');
  return { md, json: { projects: list } };
}
function allPaths(tree = profile.capabilities, prefix = '') { const out = []; for (const [k, v] of Object.entries(tree)) { const p = prefix ? `${prefix}.${k}` : k; out.push(p); if (v.children) out.push(...allPaths(v.children, p)); } return out; }
function pageSearch(q) {
  const needle = q.toLowerCase(); const hits = [];
  for (const p of allPaths()) { const n = node(p); for (const it of n.items || []) if (it.toLowerCase().includes(needle)) hits.push({ path: p, item: it, url: url(p) }); }
  const projects = profile.projects.filter((p) => JSON.stringify(p).toLowerCase().includes(needle));
  const experience = profile.experience.filter((e) => JSON.stringify(e).toLowerCase().includes(needle)).map((e) => `${e.title}, ${e.org}`);
  const md = [`# Search: ${q}`, '', '## Capability hits', ...(hits.length ? hits.map((h) => `- [${title(h.path)}] ${h.item} -> ${h.url}`) : ['- none']), '', '## Projects', ...(projects.length ? projects.map((p) => `- **${p.name}**: ${p.what}`) : ['- none']), '', '## Experience', ...(experience.length ? experience.map((e) => `- ${e}`) : ['- none']), MCP_NOTE].join('\n');
  return { md, json: { query: q, capability_hits: hits, projects, experience } };
}

export default function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Cache-Control', 'public, max-age=300');
  const u = new URL(req.url, BASE);
  const rest = u.pathname.replace(/^\/p\/?/, '').replace(/\/+$/, '');
  let page;
  if (rest === '') page = pageRoot();
  else if (rest === 'experience') page = pageExperience();
  else if (rest === 'projects') page = pageProjects(u.searchParams.get('area'));
  else if (rest === 'search') { const q = (u.searchParams.get('q') || '').trim(); page = q.length >= 2 ? pageSearch(q) : { md: '# Search\n\nAdd ?q=<keyword> (2+ characters).', json: { error: 'q required' } }; }
  else page = pageNode(rest.replace(/\//g, '.'));
  if (!page) { res.setHeader('Content-Type', 'text/markdown; charset=utf-8'); return res.status(404).end(`# Not found\n\nNo such path. Index: ${BASE}/p\n`); }
  const accept = String(req.headers.accept || '');
  if (accept.includes('application/json') && !accept.includes('text/markdown')) { res.setHeader('Content-Type', 'application/json'); return res.status(200).end(JSON.stringify(page.json, null, 2)); }
  res.setHeader('Content-Type', 'text/markdown; charset=utf-8');
  return res.status(200).end(page.md);
}
