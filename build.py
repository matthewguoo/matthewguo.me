#!/usr/bin/env python3
"""Build step: render profile.json to profile.md, and pre-render the humans page sections so fetchers see real content."""
import json
d = json.load(open('profile.json'))
L = [f"# {d['name']}", "", d['summary'], "", f"Location: {d['location']}. Languages: {', '.join(d['languages_spoken'])}.", "",
     "## Experience"]
for e in d['experience']:
    L.append(f"- {e['title']}, {e['org']} ({e['start']} to {e['end'] or 'present'}). {e['highlights'][0]}")
L += ["", "## Education"] + [f"- {x['school']}: {x.get('program','')} {x.get('status','')}".strip() for x in d['education']]
L += ["", "## Capabilities"]
def walk(tree, depth=0):
    for k, v in tree.items():
        name = k.replace('_', ' ')
        if 'children' in v:
            L.append(f"{'#' * (3 + depth)} {name}")
            if v.get('summary'): L.append(v['summary'])
            walk(v['children'], depth + 1)
        else:
            L.append(f"- **{name}**: " + '; '.join(v.get('items', [])))
walk(d['capabilities'])
L += ["", "## Projects"] + [f"- **{p['name']}** ({p['year']}): {p['what']} Status: {p['status']}" for p in d['projects']]
L += ["", "## Links"] + [f"- {k}: {v}" for k, v in d['links'].items()]
L += ["", "## Open to"] + [f"- {x}" for x in d['open_to']]
L += ["", "## Contact and calls", "Through the MCP server at https://matthewguo.me/mcp: `contact` sends a message, `availability` and `request_call` book a tentative call. No phone or email is published.", ""]
open('profile.md', 'w').write('\n'.join(L))
print('profile.md', len('\n'.join(L)), 'chars')


# ---- pre-render humans.html sections (JS re-renders the same markup for filtering) ----
import html, re
E = html.escape
def title(k): return k.replace('_', ' ')
def tree(t, depth=0):
    out = []
    for k, v in t.items():
        inner = (f"<p>{E(v['summary'])}</p>" if v.get('summary') else '') + (('<ul>' + ''.join(f'<li>{E(i)}</li>' for i in v['items']) + '</ul>') if v.get('items') else '') + (tree(v['children'], depth + 1) if v.get('children') else '')
        out.append(f"<details{' class=\"sub\"' if depth else ''}><summary>{E(title(k))}</summary>{inner}</details>")
    return ''.join(out)
sections = {
    'meta': f"<span>{E(d['headline'])}</span><span class=\"dot\">·</span><span>{E(', '.join(d['languages_spoken']))}</span>",
    'summary': E(d['summary']),
    'tl': ''.join(f"<li{'' if e['end'] else ' class=\"now\"'}><div class=\"when\">{E(e['start'])} → {E(e['end']) if e['end'] else 'now'} · {E(e['location'])}</div><h3>{E(e['title'])} <span>· {E(e['org'])}</span></h3><ul>{''.join(f'<li>{E(x)}</li>' for x in e['highlights'])}</ul></li>" for e in d['experience']),
    'edu': '<br>'.join(f"<b>{E(x['school'])}</b> · {E(x.get('program',''))} <span style=\"color:var(--muted-3)\">{E(x.get('status',''))}</span>" for x in d['education']),
    'tree': tree(d['capabilities']),
    'projects': ''.join(f"<li><b>{E(p['name'])}</b><span class=\"dim\">{E(p['area'])} · {E(p['year'])}</span><p>{E(p['what'])} <span style=\"color:var(--muted-3)\">{E(p['status'])}</span></p></li>" for p in d['projects']),
    'open': ''.join(f'<li>{E(x)}</li>' for x in d['open_to']),
}
h = open('humans.html').read()
for key, body in sections.items():
    pat = re.compile(r'(<!-- ssr:%s -->).*?(<!-- /ssr:%s -->)' % (key, key), re.S)
    assert pat.search(h), key
    h = pat.sub(lambda m: m.group(1) + body + m.group(2), h)
open('humans.html', 'w').write(h)
print('humans.html pre-rendered:', ', '.join(sections))
