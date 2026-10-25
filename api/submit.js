// Human-confirmed actions: GET ?kind=availability -> open slots; POST {kind:'contact'|'call', ...} from the forms.
import { openSlots, sendMessage, requestCall, AV, TZ } from '../lib/inbox.js';
export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  if (req.method === 'GET') {
    const u = new URL(req.url, 'https://matthewguo.me');
    if (u.searchParams.get('kind') === 'availability') return res.status(200).json({ timezone: TZ, durations_minutes: AV.durations_minutes, note: AV.note, slots: await openSlots(AV.horizon_days) });
    return res.status(400).json({ error: 'kind=availability' });
  }
  if (req.method !== 'POST') return res.status(405).end();
  let b = req.body; if (typeof b === 'string') { try { b = JSON.parse(b); } catch { return res.status(400).json({ error: 'bad json' }); } }
  if (!b || typeof b !== 'object') return res.status(400).json({ error: 'bad body' });
  if (b.website) return res.status(200).json({ ok: true, result: { text: 'Thanks.' } }); // honeypot
  const r = b.kind === 'contact' ? await sendMessage(b, req, 'form') : b.kind === 'call' ? await requestCall(b, req, 'form') : { ok: false, error: 'kind must be contact or call' };
  return res.status(r.ok ? 200 : 400).json(r);
}
