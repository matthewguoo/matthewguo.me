# matthewguo.me

Personal site. `index.html` is the page; `api/mcp.js` is a small MCP server (Streamable HTTP, stateless) served at `/mcp`.

- `about`, `links`: read from `profile.json`. Edit that file to change what agents are told.
- `contact`: writes a JSON record to the private Vercel Blob store `matthewguo-inbox` under `inbox/`. Read them with `vercel blob list` or the Vercel dashboard. If `RESEND_API_KEY` and `CONTACT_EMAIL` are set, each message is also emailed.

Deployed on Vercel from this repo.
