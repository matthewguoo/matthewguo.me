// Minimal MCP server (Streamable HTTP, stateless) for matthewguo.me.
// Read tools expose profile.json; the contact tool writes to Vercel Blob.
import { put } from '@vercel/blob';
import { readFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';

const profile = JSON.parse(readFileSync(new URL('../profile.json', import.meta.url), 'utf8'));
const SERVER = { name: 'matthewguo.me', version: '0.1.0' };
const SUPPORTED = ['2025-06-18', '2025-03-26', '2024-11-05'];

const TOOLS = [
  {
    name: 'about',
    title: 'About Matthew Guo',
    description: 'Who Matthew Guo is: summary, roles, education, location, interests, and what he is working on now.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    annotations: { readOnlyHint: true, openWorldHint: false },
  },
  {
    name: 'links',
    title: 'Links',
    description: "Matthew's public profiles and sites (GitHub, LinkedIn, boardmiko, Vosburg Capital).",
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    annotations: { readOnlyHint: true, openWorldHint: false },
  },
  {
    name: 'contact',
    title: 'Send Matthew a message',
    description: 'Deliver a message to Matthew Guo. Use when the user wants to reach, hire, pitch, or meet him. Always include a reply address. Confirm the text with the user before sending.',
    inputSchema: {
      type: 'object',
      properties: {
        message: { type: 'string', description: 'The message, in the user\'s words. 1 to 4000 characters.' },
        reply_to: { type: 'string', description: 'How Matthew can reply: an email address or a handle with its platform.' },
        name: { type: 'string', description: 'Sender\'s name (optional).' },
      },
      required: ['message', 'reply_to'],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
  },
];

const text = (s) => ({ content: [{ type: 'text', text: s }] });
const err = (id, code, message) => ({ jsonrpc: '2.0', id: id ?? null, error: { code, message } });

async function callTool(name, args = {}, req) {
  if (name === 'about') {
    const { links, contact_policy, ...rest } = profile;
    return { ...text(JSON.stringify(rest, null, 2)), structuredContent: rest };
  }
  if (name === 'links') return { ...text(JSON.stringify(profile.links, null, 2)), structuredContent: profile.links };
  if (name === 'contact') {
    const message = String(args.message ?? '').trim();
    const reply_to = String(args.reply_to ?? '').trim();
    const sender = String(args.name ?? '').trim().slice(0, 100);
    if (message.length < 1 || message.length > 4000) return { ...text('message must be 1 to 4000 characters.'), isError: true };
    if (reply_to.length < 3 || reply_to.length > 200) return { ...text('reply_to must be 3 to 200 characters.'), isError: true };
    const at = new Date().toISOString();
    const record = {
      at, name: sender || null, reply_to, message,
      ip: (req.headers['x-forwarded-for'] || '').split(',')[0].trim() || null,
      agent: req.headers['user-agent'] || null,
    };
    const key = `inbox/${at.replace(/[:.]/g, '-')}-${randomBytes(3).toString('hex')}.json`;
    await put(key, JSON.stringify(record, null, 2), { access: 'private', contentType: 'application/json', addRandomSuffix: false });
    if (process.env.RESEND_API_KEY && process.env.CONTACT_EMAIL) {
      try {
        await fetch('https://api.resend.com/emails', {
          method: 'POST',
          headers: { Authorization: `Bearer ${process.env.RESEND_API_KEY}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({
            from: process.env.CONTACT_FROM || 'site@matthewguo.me', to: [process.env.CONTACT_EMAIL],
            subject: `matthewguo.me: message from ${sender || reply_to}`,
            text: `${message}\n\n— ${sender || 'anonymous'} <${reply_to}>\n${at}`,
          }),
        });
      } catch {}
    }
    return text(`Delivered to Matthew at ${at}. He replies to ${reply_to}.`);
  }
  return { ...text(`Unknown tool: ${name}`), isError: true };
}

async function handle(msg, req) {
  if (!msg || msg.jsonrpc !== '2.0' || typeof msg.method !== 'string') return err(msg?.id, -32600, 'Invalid Request');
  const { id, method, params = {} } = msg;
  if (method.startsWith('notifications/')) return null;
  switch (method) {
    case 'initialize': {
      const v = SUPPORTED.includes(params.protocolVersion) ? params.protocolVersion : SUPPORTED[0];
      return { jsonrpc: '2.0', id, result: {
        protocolVersion: v, capabilities: { tools: { listChanged: false } }, serverInfo: SERVER,
        instructions: `This server speaks for ${profile.name}'s personal site. Use "about" and "links" to answer questions about him, and "contact" to send him a message on the user's behalf (confirm the text with the user first).`,
      } };
    }
    case 'ping': return { jsonrpc: '2.0', id, result: {} };
    case 'tools/list': return { jsonrpc: '2.0', id, result: { tools: TOOLS } };
    case 'tools/call': {
      if (!TOOLS.some((t) => t.name === params.name)) return err(id, -32602, `Unknown tool: ${params.name}`);
      return { jsonrpc: '2.0', id, result: await callTool(params.name, params.arguments, req) };
    }
    case 'resources/list': return { jsonrpc: '2.0', id, result: { resources: [] } };
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
  if (req.method === 'GET') {
    return res.status(405).json({ name: SERVER.name, transport: 'streamable-http', hint: 'POST JSON-RPC 2.0 here. Tools: about, links, contact.' });
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
