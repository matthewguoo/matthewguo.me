#!/usr/bin/env python3
"""Render profile.json to profile.md: a compact summary for agents that can only fetch pages."""
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
