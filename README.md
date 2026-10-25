# matthewguo.me

Personal site. `index.html` is the page; `api/mcp.js` is a small MCP server (Streamable HTTP, stateless) served at `/mcp`.

- `about`, `links`: read from `profile.json`. Edit that file to change what agents are told.
- `availability` / `request_call`: open slots come from `availability` in `profile.json` (windows, lead time, horizon); requests are written to the same Blob store under `calls/` and include an ICS for the requester. Confirm by replying to them.
- `contact`: writes a JSON record to the private Vercel Blob store `matthewguo-inbox` under `inbox/`. Read them with `vercel blob list` or the Vercel dashboard. If `RESEND_API_KEY` and `CONTACT_EMAIL` are set, each message is also emailed.

Deployed on Vercel from this repo.

- `build.py` regenerates `profile.md` and pre-renders the sections of `humans.html` from `profile.json`; run it after editing the profile.
