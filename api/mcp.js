// MCP server (Streamable HTTP, stateless) for matthewguo.me.
// Read tools walk profile.json as a tree; the contact tool writes to Vercel Blob.
import { put, list } from '@vercel/blob';
import { readFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';

const profile = JSON.parse(readFileSync(new URL('../profile.json', import.meta.url), 'utf8'));
const SERVER = { name: 'matthewguo.me', version: '0.4.0' };
const SUPPORTED = ['2025-06-18', '2025-03-26', '2024-11-05'];
const RO = { readOnlyHint: true, openWorldHint: false };

// ---- capability tree helpers ------------------------------------------------
function node(path) {
  if (!path) return profile.capabilities;
  let cur = { children: profile.capabilities };
  for (const seg of path.split('.').filter(Boolean)) {
    if (!cur.children || !cur.children[seg]) return null;
    cur = cur.children[seg];
  }
  return cur;
}
function describe(path) {
  const n = node(path);
  if (!n) return null;
  const children = n.children ?? (path ? null : n);
  const out = { path: path || '', summary: n.summary ?? null };
  if (path === '' ) {
    out.children = Object.fromEntries(Object.entries(profile.capabilities).map(([k, v]) => [k, v.summary ?? null]));
  } else if (children) {
    out.children = Object.fromEntries(Object.entries(children).map(([k, v]) => [k, v.summary ?? (v.items ? `${v.items.length} items` : null)]));
  }
  if (n.items) out.items = n.items;
  out.hint = out.children ? 'Call capabilities again with path "<path>.<child>" to go deeper.' : 'Leaf node.';
  return out;
}
function allPaths(tree = profile.capabilities, prefix = '') {
  const out = [];
  for (const [k, v] of Object.entries(tree)) {
    const p = prefix ? `${prefix}.${k}` : k;
    out.push(p);
    if (v.children) out.push(...allPaths(v.children, p));
  }
  return out;
}
function search(q) {
  const needle = q.toLowerCase();
  const hits = [];
  for (const p of allPaths()) {
    const n = node(p);
    for (const it of n.items ?? []) if (it.toLowerCase().includes(needle)) hits.push({ path: p, item: it });
    if ((n.summary ?? '').toLowerCase().includes(needle)) hits.push({ path: p, summary: n.summary });
  }
  const projects = profile.projects.filter((pr) => JSON.stringify(pr).toLowerCase().includes(needle));
  const experience = profile.experience.filter((e) => JSON.stringify(e).toLowerCase().includes(needle)).map((e) => ({ org: e.org, title: e.title, start: e.start, end: e.end }));
  return { query: q, capability_hits: hits, projects, experience };
}


// ---- scheduling helpers ------------------------------------------------------
const AV = profile.availability;
const TZ = AV.timezone;
const dtf = new Intl.DateTimeFormat('en-US', { timeZone: TZ, hour12: false, weekday: 'short', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', timeZoneName: 'short' });
const WD = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
function local(d) {
  const parts = Object.fromEntries(dtf.formatToParts(d).map((p) => [p.type, p.value]));
  return { weekday: WD[parts.weekday], minutes: (parseInt(parts.hour, 10) % 24) * 60 + parseInt(parts.minute, 10), date: `${parts.year}-${parts.month}-${parts.day}`, tzName: parts.timeZoneName };
}
const hm = (s) => { const [h, m] = s.split(':').map(Number); return h * 60 + m; };
function inWindow(start, minutes) {
  const a = local(start), end = new Date(start.getTime() + minutes * 60000), b = local(end);
  if (a.date !== b.date) return false;
  return AV.windows.some((w) => w.days.includes(a.weekday) && a.minutes >= hm(w.start) && b.minutes <= hm(w.end));
}
function fmt(d) { const parts = dtf.formatToParts(d); const g = (t) => parts.find((p) => p.type === t).value; return `${g('weekday')} ${g('year')}-${g('month')}-${g('day')} ${g('hour')}:${g('minute')} ${g('timeZoneName')}`; }
async function takenSlots() {
  try {
    const { blobs } = await list({ prefix: 'calls/' });
    return blobs.map((b) => { const m = b.pathname.match(/calls\/(\d{4}-\d{2}-\d{2}T\d{2}-\d{2})/); return m ? m[1].replace(/T(\d{2})-(\d{2})/, 'T$1:$2') : null; }).filter(Boolean);
  } catch { return []; }
}
async function openSlots(limitDays, maxSlots = 24) {
  const now = Date.now(), lead = now + AV.lead_time_hours * 3600000, horizon = now + Math.min(limitDays || AV.horizon_days, AV.horizon_days) * 86400000;
  const taken = new Set(await takenSlots());
  const grid = AV.slot_grid_minutes * 60000;
  const out = [];
  for (let t = Math.ceil(lead / grid) * grid; t < horizon && out.length < maxSlots; t += grid) {
    const d = new Date(t);
    if (!inWindow(d, AV.slot_grid_minutes)) continue;
    const key = d.toISOString().slice(0, 16);
    if (taken.has(key)) continue;
    out.push({ start: d.toISOString(), local: fmt(d) });
  }
  return out;
}
function ics({ start, minutes, topic, name, reply_to }) {
  const s = new Date(start), e = new Date(s.getTime() + minutes * 60000);
  const st = (d) => d.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
  return ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//matthewguo.me//MCP//EN', 'METHOD:REQUEST', 'BEGIN:VEVENT', `UID:${st(s)}-${randomBytes(4).toString('hex')}@matthewguo.me`, `DTSTAMP:${st(new Date())}`, `DTSTART:${st(s)}`, `DTEND:${st(e)}`, `SUMMARY:Call with Matthew Guo${topic ? ': ' + topic.replace(/[\r\n]+/g, ' ') : ''}`, `DESCRIPTION:Requested via matthewguo.me/mcp by ${name || reply_to} (${reply_to}). Pending Matthew's confirmation.`, 'STATUS:TENTATIVE', 'END:VEVENT', 'END:VCALENDAR'].join('\r\n');
}

// ---- tools -------------------------------------------------------------------
const TOOLS = [
  { name: 'about', title: 'About Matthew Guo', description: 'Short bio: who he is, where, current roles, education, what he is open to. Start here.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false }, annotations: RO },
  { name: 'experience', title: 'Work history and education', description: 'Dated work history with highlights per role, plus education.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false }, annotations: RO },
  { name: 'capabilities', title: 'Capability tree', description: 'Hierarchical skills and capabilities with evidence. Call with no path for the top level (hardware, embedded_and_firmware, software, trading_systems_and_risk, leadership_and_programs), then pass a dotted path such as "hardware.interfaces.high_speed_serial" to go deeper. Pass path "*" to get every path at once.',
    inputSchema: { type: 'object', properties: { path: { type: 'string', description: 'Dotted path into the tree, e.g. "hardware.interfaces". Empty for the root, "*" for the full list of paths.' } }, additionalProperties: false }, annotations: RO },
  { name: 'search', title: 'Search capabilities, projects and experience', description: 'Keyword search across the capability tree, project list and work history. Use for "has he done X" questions (PCIe, Yocto, CAN, FPGA, risk, mypy, etc.).',
    inputSchema: { type: 'object', properties: { query: { type: 'string', description: 'Keyword or phrase.' } }, required: ['query'], additionalProperties: false }, annotations: RO },
  { name: 'projects', title: 'Projects', description: 'Project list with scale and status. Optional area filter: hardware, tooling, trading, quant, simulation, math.',
    inputSchema: { type: 'object', properties: { area: { type: 'string' } }, additionalProperties: false }, annotations: RO },
  { name: 'links', title: 'Links', description: "Matthew's public profiles and sites.",
    inputSchema: { type: 'object', properties: {}, additionalProperties: false }, annotations: RO },
  { name: 'availability', title: 'Open call slots', description: "Matthew's open slots for a call over the next two weeks, in his timezone and as ISO UTC. Use before request_call. Optional days limit.",
    inputSchema: { type: 'object', properties: { days: { type: 'integer', minimum: 1, maximum: 14, description: 'How many days ahead to look (default 14).' } }, additionalProperties: false }, annotations: RO },
  { name: 'request_call', title: 'Request a call with Matthew', description: 'Book a tentative 15 or 30 minute call at one of the open slots from availability. Writes a request Matthew confirms by reply; returns an ICS the user can add to their calendar. Confirm the slot, topic and reply address with the user before calling.',
    inputSchema: { type: 'object', properties: {
      start: { type: 'string', description: 'Slot start as ISO 8601 (use a value from availability).' },
      duration_minutes: { type: 'integer', enum: [15, 30], description: 'Call length. Default 30.' },
      topic: { type: 'string', description: 'What the call is about. 1 to 500 characters.' },
      reply_to: { type: 'string', description: 'Email address for the confirmation.' },
      name: { type: 'string', description: "Requester's name (optional)." },
      timezone: { type: 'string', description: "Requester's IANA timezone, for the confirmation (optional)." } },
      required: ['start', 'topic', 'reply_to'], additionalProperties: false },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true } },
  { name: 'contact', title: 'Send Matthew a message', description: 'Deliver a message to Matthew Guo. Use when the user wants to reach, hire, pitch or meet him. Always include a reply address. Confirm the text with the user before sending.',
    inputSchema: { type: 'object', properties: {
      message: { type: 'string', description: "The message, in the user's words. 1 to 4000 characters." },
      reply_to: { type: 'string', description: 'How Matthew can reply: an email address or a handle with its platform.' },
      name: { type: 'string', description: "Sender's name (optional)." } }, required: ['message', 'reply_to'], additionalProperties: false },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true } },
];

const text = (s) => ({ content: [{ type: 'text', text: s }] });
const both = (obj) => ({ ...text(JSON.stringify(obj, null, 2)), structuredContent: obj });
const err = (id, code, message) => ({ jsonrpc: '2.0', id: id ?? null, error: { code, message } });

async function callTool(name, args = {}, req) {
  switch (name) {
    case 'about': {
      const { name: n, headline, summary, location, languages_spoken, education, now, working_style, open_to } = profile;
      const roles = profile.experience.filter((e) => !e.end).map((e) => `${e.title}, ${e.org} (since ${e.start})`);
      return both({ name: n, headline, summary, location, current_roles: roles, education, languages_spoken, now, working_style, open_to, see_also: 'experience, capabilities (tree), search, projects, links, contact' });
    }
    case 'experience': return both({ experience: profile.experience, education: profile.education });
    case 'capabilities': {
      const path = typeof args.path === 'string' ? args.path.trim() : '';
      if (path === '*') return both({ paths: allPaths(), hint: 'Pass any of these as path.' });
      const d = describe(path);
      if (!d) return { ...text(`No such path: ${path}. Valid paths: ${allPaths().join(', ')}`), isError: true };
      return both(d);
    }
    case 'search': {
      const q = String(args.query ?? '').trim();
      if (q.length < 2) return { ...text('query must be at least 2 characters.'), isError: true };
      return both(search(q));
    }
    case 'projects': {
      const area = typeof args.area === 'string' ? args.area.toLowerCase() : null;
      return both({ projects: area ? profile.projects.filter((p) => p.area === area) : profile.projects, notes: profile.notes_for_agents });
    }
    case 'links': return both(profile.links);
    case 'availability': {
      const slots = await openSlots(Number.isInteger(args.days) ? args.days : AV.horizon_days);
      return both({ timezone: TZ, windows: AV.windows, durations_minutes: AV.durations_minutes, lead_time_hours: AV.lead_time_hours, note: AV.note, slots });
    }
    case 'request_call': {
      const start = new Date(String(args.start ?? ''));
      const minutes = Number.isInteger(args.duration_minutes) ? args.duration_minutes : 30;
      const topic = String(args.topic ?? '').trim();
      const reply_to = String(args.reply_to ?? '').trim();
      const sender = String(args.name ?? '').trim().slice(0, 100);
      const tz = String(args.timezone ?? '').trim().slice(0, 64) || null;
      if (Number.isNaN(start.getTime())) return { ...text('start must be an ISO 8601 datetime.'), isError: true };
      if (!AV.durations_minutes.includes(minutes)) return { ...text(`duration_minutes must be one of ${AV.durations_minutes.join(', ')}.`), isError: true };
      if (topic.length < 1 || topic.length > 500) return { ...text('topic must be 1 to 500 characters.'), isError: true };
      if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(reply_to)) return { ...text('reply_to must be an email address.'), isError: true };
      if (start.getTime() < Date.now() + AV.lead_time_hours * 3600000) return { ...text(`Slots need ${AV.lead_time_hours} hours of lead time. Call availability for open slots.`), isError: true };
      if (start.getTime() > Date.now() + AV.horizon_days * 86400000) return { ...text(`Slots are offered up to ${AV.horizon_days} days ahead.`), isError: true };
      if (start.getTime() % (AV.slot_grid_minutes * 60000) !== 0) return { ...text(`Starts fall on a ${AV.slot_grid_minutes}-minute grid. Call availability for open slots.`), isError: true };
      if (!inWindow(start, minutes)) return { ...text(`That time is outside Matthew's call windows (${TZ}). Call availability for open slots.`), isError: true };
      const key = start.toISOString().slice(0, 16);
      if ((await takenSlots()).includes(key)) return { ...text('That slot was just taken. Call availability again.'), isError: true };
      const at = new Date().toISOString();
      const record = { at, start: start.toISOString(), minutes, topic, name: sender || null, reply_to, requester_timezone: tz, ip: (req.headers['x-forwarded-for'] || '').split(',')[0].trim() || null, agent: req.headers['user-agent'] || null };
      await put(`calls/${key.replace(/:/g, '-')}-${randomBytes(3).toString('hex')}.json`, JSON.stringify(record, null, 2), { access: 'private', contentType: 'application/json', addRandomSuffix: false });
      const calendar = ics({ start: start.toISOString(), minutes, topic, name: sender, reply_to });
      const summary = `Requested a ${minutes}-minute call on ${fmt(start)} (${start.toISOString()} UTC). Matthew confirms to ${reply_to}, usually within a day. The ICS below is tentative until then.`;
      return { content: [{ type: 'text', text: summary }, { type: 'text', text: calendar }], structuredContent: { status: 'requested', start: start.toISOString(), local: fmt(start), minutes, reply_to, ics: calendar } };
    }
    case 'contact': {
      const message = String(args.message ?? '').trim();
      const reply_to = String(args.reply_to ?? '').trim();
      const sender = String(args.name ?? '').trim().slice(0, 100);
      if (message.length < 1 || message.length > 4000) return { ...text('message must be 1 to 4000 characters.'), isError: true };
      if (reply_to.length < 3 || reply_to.length > 200) return { ...text('reply_to must be 3 to 200 characters.'), isError: true };
      const at = new Date().toISOString();
      const record = { at, name: sender || null, reply_to, message, ip: (req.headers['x-forwarded-for'] || '').split(',')[0].trim() || null, agent: req.headers['user-agent'] || null };
      const key = `inbox/${at.replace(/[:.]/g, '-')}-${randomBytes(3).toString('hex')}.json`;
      await put(key, JSON.stringify(record, null, 2), { access: 'private', contentType: 'application/json', addRandomSuffix: false });
      if (process.env.RESEND_API_KEY && process.env.CONTACT_EMAIL) {
        try {
          await fetch('https://api.resend.com/emails', { method: 'POST', headers: { Authorization: `Bearer ${process.env.RESEND_API_KEY}`, 'Content-Type': 'application/json' },
            body: JSON.stringify({ from: process.env.CONTACT_FROM || 'site@matthewguo.me', to: [process.env.CONTACT_EMAIL], subject: `matthewguo.me: message from ${sender || reply_to}`, text: `${message}\n\n— ${sender || 'anonymous'} <${reply_to}>\n${at}` }) });
        } catch {}
      }
      return text(`Delivered to Matthew at ${at}. He replies to ${reply_to}.`);
    }
    default: return { ...text(`Unknown tool: ${name}`), isError: true };
  }
}

// ---- resources (same data, addressable) -------------------------------------
function resources() {
  const list = [
    { uri: 'profile://about', name: 'about', mimeType: 'application/json', description: 'Short bio' },
    { uri: 'profile://experience', name: 'experience', mimeType: 'application/json', description: 'Work history and education' },
    { uri: 'profile://projects', name: 'projects', mimeType: 'application/json', description: 'Project list' },
    { uri: 'profile://capabilities', name: 'capabilities', mimeType: 'application/json', description: 'Capability tree root' },
  ];
  for (const p of allPaths()) list.push({ uri: `profile://capabilities/${p.replace(/\./g, '/')}`, name: p, mimeType: 'application/json', description: node(p).summary ?? `${(node(p).items ?? []).length} items` });
  return list;
}
async function readResource(uri) {
  let data;
  if (uri === 'profile://about') data = (await callTool('about')).structuredContent;
  else if (uri === 'profile://experience') data = { experience: profile.experience, education: profile.education };
  else if (uri === 'profile://projects') data = profile.projects;
  else if (uri.startsWith('profile://capabilities')) data = describe(uri.slice('profile://capabilities'.length).replace(/^\//, '').replace(/\//g, '.'));
  if (!data) return null;
  return { contents: [{ uri, mimeType: 'application/json', text: JSON.stringify(data, null, 2) }] };
}

// ---- JSON-RPC ----------------------------------------------------------------
async function handle(msg, req) {
  if (!msg || msg.jsonrpc !== '2.0' || typeof msg.method !== 'string') return err(msg?.id, -32600, 'Invalid Request');
  const { id, method, params = {} } = msg;
  if (method.startsWith('notifications/')) return null;
  switch (method) {
    case 'initialize': {
      const v = SUPPORTED.includes(params.protocolVersion) ? params.protocolVersion : SUPPORTED[0];
      return { jsonrpc: '2.0', id, result: { protocolVersion: v, capabilities: { tools: { listChanged: false }, resources: { subscribe: false, listChanged: false } }, serverInfo: SERVER,
        instructions: `This server speaks for ${profile.name}'s personal site. Start with "about". Use "experience" for work history, "capabilities" to walk the skills tree (hardware, embedded, software, trading and risk, leadership), "search" for "has he done X" questions, "projects" for the project list, "availability" then "request_call" to book a tentative call, and "contact" to send him a message on the user's behalf (confirm the text with the user first). Phone and email are not published; contact is the channel.` } };
    }
    case 'ping': return { jsonrpc: '2.0', id, result: {} };
    case 'tools/list': return { jsonrpc: '2.0', id, result: { tools: TOOLS } };
    case 'tools/call': {
      if (!TOOLS.some((t) => t.name === params.name)) return err(id, -32602, `Unknown tool: ${params.name}`);
      return { jsonrpc: '2.0', id, result: await callTool(params.name, params.arguments, req) };
    }
    case 'resources/list': return { jsonrpc: '2.0', id, result: { resources: resources() } };
    case 'resources/read': {
      const r = await readResource(String(params.uri ?? ''));
      return r ? { jsonrpc: '2.0', id, result: r } : err(id, -32002, `Resource not found: ${params.uri}`);
    }
    case 'resources/templates/list': return { jsonrpc: '2.0', id, result: { resourceTemplates: [] } };
    case 'prompts/list': return { jsonrpc: '2.0', id, result: { prompts: [] } };
    default: return err(id, -32601, `Method not found: ${method}`);
  }
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Accept, Authorization, Mcp-Session-Id, MCP-Protocol-Version, Last-Event-ID');
  res.setHeader('Access-Control-Expose-Headers', 'Mcp-Session-Id, MCP-Protocol-Version');
  if (req.method === 'OPTIONS') return res.status(204).end();
  if (req.method === 'DELETE') return res.status(200).end();
  if (req.method === 'GET' || req.method === 'HEAD') {
    const desc = {
      name: SERVER.name, version: SERVER.version, transport: 'streamable-http', endpoint: 'https://matthewguo.me/mcp', auth: 'none',
      description: `MCP server for Matthew Guo's personal site. It answers questions about him (bio, work history, a hierarchical capability tree, projects) and takes two actions on a user's behalf: request a call and send him a message.`,
      how_to_connect: { claude: 'Settings -> Connectors -> Add custom connector -> paste the endpoint', claude_code: 'claude mcp add --transport http matthewguo https://matthewguo.me/mcp', cursor: '{"mcpServers":{"matthewguo":{"url":"https://matthewguo.me/mcp"}}}', codex: 'codex mcp add matthewguo --url https://matthewguo.me/mcp', vscode: `code --add-mcp '{"name":"matthewguo","type":"http","url":"https://matthewguo.me/mcp"}'` },
      without_mcp: 'The same data is a static file at https://matthewguo.me/profile.json. Contact and scheduling need the MCP tools.',
      tools: TOOLS.map((t) => ({ name: t.name, description: t.description, input: Object.keys(t.inputSchema.properties || {}) })),
      resources: 'resources/list exposes profile:// URIs for the same data.',
      protocol: 'POST JSON-RPC 2.0 (initialize, tools/list, tools/call, resources/list, resources/read, ping) to this URL.',
    };
    const accept = String(req.headers.accept || '');
    if (accept.includes('text/html') && !accept.includes('application/json')) {
      const esc = (x) => String(x).replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));
      const rows = desc.tools.map((t) => `<tr><td><code>${esc(t.name)}</code></td><td>${esc(t.description)}</td></tr>`).join('');
      res.setHeader('Content-Type', 'text/html; charset=utf-8');
      return res.status(200).end(`<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>matthewguo.me/mcp</title><link rel="icon" href="/assets/icon-32.png"><style>:root{--sakura:#8e2130;--ink:#1a1a1a;--muted:#555;--bg:#f5f5f5;--line:#1a1a1a24}body{margin:0;background:var(--bg);color:var(--ink);font:15px/1.6 Inter,system-ui,sans-serif;padding:0 28px}body::before{content:"";position:fixed;top:0;left:0;right:0;height:3px;background:var(--sakura)}main{max-width:760px;margin:0 auto;padding:48px 0}h1{font-size:22px;letter-spacing:-.02em;margin:0 0 8px}p{color:var(--muted);margin:0 0 14px}code{font:13px ui-monospace,Menlo,monospace}table{border-collapse:collapse;width:100%;background:#fff;border:1px solid var(--line);font-size:14px}td{padding:8px 12px;border-top:1px solid var(--line);vertical-align:top}td:first-child{white-space:nowrap}a{color:var(--sakura);text-decoration:none}</style></head><body><main><h1>matthewguo.me/mcp</h1><p>${esc(desc.description)} Streamable HTTP, no auth.</p><p>Endpoint: <code>https://matthewguo.me/mcp</code>. Data without MCP: <a href="/profile.json">/profile.json</a>. Site: <a href="/">matthewguo.me</a>.</p><table>${rows}</table><p style="margin-top:14px">Claude Code: <code>claude mcp add --transport http matthewguo https://matthewguo.me/mcp</code></p></main></body></html>`);
    }
    res.setHeader('Content-Type', 'application/json');
    return res.status(200).end(req.method === 'HEAD' ? '' : JSON.stringify(desc, null, 2));
  }
  if (req.method !== 'POST') return res.status(405).end();
  let body = req.body;
  if (typeof body === 'string') { try { body = JSON.parse(body); } catch { return res.status(400).json(err(null, -32700, 'Parse error')); } }
  if (!body) return res.status(400).json(err(null, -32700, 'Parse error'));
  const msgs = Array.isArray(body) ? body : [body];
  const out = (await Promise.all(msgs.map((m) => handle(m, req)))).filter(Boolean);
  if (out.length === 0) return res.status(202).end();
  res.setHeader('Content-Type', 'application/json');
  return res.status(200).json(Array.isArray(body) ? out : out[0]);
}
