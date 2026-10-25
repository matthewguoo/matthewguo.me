// Shared logic for the MCP tools and the human-confirmed forms: validation, Blob writes, availability, ICS.
import { put, list } from '@vercel/blob';
import { readFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';

export const profile = JSON.parse(readFileSync(new URL('../profile.json', import.meta.url), 'utf8'));
export const AV = profile.availability;
export const TZ = AV.timezone;
const dtf = new Intl.DateTimeFormat('en-US', { timeZone: TZ, hour12: false, weekday: 'short', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', timeZoneName: 'short' });
const WD = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
function local(d) { const p = Object.fromEntries(dtf.formatToParts(d).map((x) => [x.type, x.value])); return { weekday: WD[p.weekday], minutes: (parseInt(p.hour, 10) % 24) * 60 + parseInt(p.minute, 10), date: `${p.year}-${p.month}-${p.day}` }; }
const hm = (s) => { const [h, m] = s.split(':').map(Number); return h * 60 + m; };
export function inWindow(start, minutes) { const a = local(start), b = local(new Date(start.getTime() + minutes * 60000)); if (a.date !== b.date) return false; return AV.windows.some((w) => w.days.includes(a.weekday) && a.minutes >= hm(w.start) && b.minutes <= hm(w.end)); }
export function fmt(d) { const parts = dtf.formatToParts(d); const g = (t) => parts.find((p) => p.type === t).value; return `${g('weekday')} ${g('year')}-${g('month')}-${g('day')} ${g('hour')}:${g('minute')} ${g('timeZoneName')}`; }
export async function takenSlots() { try { const { blobs } = await list({ prefix: 'calls/' }); return blobs.map((b) => { const m = b.pathname.match(/calls\/(\d{4}-\d{2}-\d{2}T\d{2}-\d{2})/); return m ? m[1].replace(/T(\d{2})-(\d{2})/, 'T$1:$2') : null; }).filter(Boolean); } catch { return []; } }
export async function openSlots(limitDays, maxSlots = 40) {
  const now = Date.now(), lead = now + AV.lead_time_hours * 3600000, horizon = now + Math.min(limitDays || AV.horizon_days, AV.horizon_days) * 86400000;
  const taken = new Set(await takenSlots()); const grid = AV.slot_grid_minutes * 60000; const out = [];
  for (let t = Math.ceil(lead / grid) * grid; t < horizon && out.length < maxSlots; t += grid) { const d = new Date(t); if (!inWindow(d, AV.slot_grid_minutes)) continue; if (taken.has(d.toISOString().slice(0, 16))) continue; out.push({ start: d.toISOString(), local: fmt(d) }); }
  return out;
}
export function ics({ start, minutes, topic, name, reply_to }) {
  const s = new Date(start), e = new Date(s.getTime() + minutes * 60000); const st = (d) => d.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
  return ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//matthewguo.me//MCP//EN', 'METHOD:REQUEST', 'BEGIN:VEVENT', `UID:${st(s)}-${randomBytes(4).toString('hex')}@matthewguo.me`, `DTSTAMP:${st(new Date())}`, `DTSTART:${st(s)}`, `DTEND:${st(e)}`, `SUMMARY:Call with Matthew Guo${topic ? ': ' + topic.replace(/[\r\n]+/g, ' ') : ''}`, `DESCRIPTION:Requested via matthewguo.me by ${name || reply_to} (${reply_to}). Pending Matthew's confirmation.`, 'STATUS:TENTATIVE', 'END:VEVENT', 'END:VCALENDAR'].join('\r\n');
}
const meta = (req, via) => ({ via, ip: (req.headers['x-forwarded-for'] || '').split(',')[0].trim() || null, agent: req.headers['user-agent'] || null });

// Returns { ok, error?, result? } without throwing.
export async function sendMessage(args, req, via) {
  const message = String(args.message ?? '').trim(), reply_to = String(args.reply_to ?? '').trim(), sender = String(args.name ?? '').trim().slice(0, 100);
  if (message.length < 1 || message.length > 4000) return { ok: false, error: 'message must be 1 to 4000 characters.' };
  if (reply_to.length < 3 || reply_to.length > 200) return { ok: false, error: 'reply_to must be 3 to 200 characters.' };
  const at = new Date().toISOString();
  await put(`inbox/${at.replace(/[:.]/g, '-')}-${randomBytes(3).toString('hex')}.json`, JSON.stringify({ at, name: sender || null, reply_to, message, ...meta(req, via) }, null, 2), { access: 'private', contentType: 'application/json', addRandomSuffix: false });
  if (process.env.RESEND_API_KEY && process.env.CONTACT_EMAIL) { try { await fetch('https://api.resend.com/emails', { method: 'POST', headers: { Authorization: `Bearer ${process.env.RESEND_API_KEY}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ from: process.env.CONTACT_FROM || 'site@matthewguo.me', to: [process.env.CONTACT_EMAIL], subject: `matthewguo.me: message from ${sender || reply_to}`, text: `${message}\n\n— ${sender || 'anonymous'} <${reply_to}>\n${at} via ${via}` }) }); } catch {} }
  return { ok: true, result: { at, reply_to, text: `Delivered to Matthew at ${at}. He replies to ${reply_to}.` } };
}
export async function requestCall(args, req, via) {
  const start = new Date(String(args.start ?? '')); const minutes = Number(args.duration_minutes ?? 30); const topic = String(args.topic ?? '').trim(); const reply_to = String(args.reply_to ?? '').trim(); const sender = String(args.name ?? '').trim().slice(0, 100); const tz = String(args.timezone ?? '').trim().slice(0, 64) || null;
  if (Number.isNaN(start.getTime())) return { ok: false, error: 'start must be an ISO 8601 datetime.' };
  if (!AV.durations_minutes.includes(minutes)) return { ok: false, error: `duration_minutes must be one of ${AV.durations_minutes.join(', ')}.` };
  if (topic.length < 1 || topic.length > 500) return { ok: false, error: 'topic must be 1 to 500 characters.' };
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(reply_to)) return { ok: false, error: 'reply_to must be an email address.' };
  if (start.getTime() < Date.now() + AV.lead_time_hours * 3600000) return { ok: false, error: `Slots need ${AV.lead_time_hours} hours of lead time.` };
  if (start.getTime() > Date.now() + AV.horizon_days * 86400000) return { ok: false, error: `Slots are offered up to ${AV.horizon_days} days ahead.` };
  if (start.getTime() % (AV.slot_grid_minutes * 60000) !== 0) return { ok: false, error: `Starts fall on a ${AV.slot_grid_minutes}-minute grid.` };
  if (!inWindow(start, minutes)) return { ok: false, error: `That time is outside Matthew's call windows (${TZ}).` };
  const key = start.toISOString().slice(0, 16);
  if ((await takenSlots()).includes(key)) return { ok: false, error: 'That slot was just taken.' };
  const at = new Date().toISOString();
  await put(`calls/${key.replace(/:/g, '-')}-${randomBytes(3).toString('hex')}.json`, JSON.stringify({ at, start: start.toISOString(), minutes, topic, name: sender || null, reply_to, requester_timezone: tz, ...meta(req, via) }, null, 2), { access: 'private', contentType: 'application/json', addRandomSuffix: false });
  const calendar = ics({ start: start.toISOString(), minutes, topic, name: sender, reply_to });
  return { ok: true, result: { status: 'requested', start: start.toISOString(), local: fmt(start), minutes, reply_to, ics: calendar, text: `Requested a ${minutes}-minute call on ${fmt(start)} (${start.toISOString()} UTC). Matthew confirms to ${reply_to}, usually within a day.` } };
}
