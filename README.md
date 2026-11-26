# CoSens demo

The source of [demo.cosens.ai](https://demo.cosens.ai): live demos that call the CoSens APIs.

## Investor demo

A fictional investor's contacts and meeting notes go in, CoSens learns their investment method from two past
projects, then analyzes a new business plan and names the people to check it with, with sources. All names,
companies and documents under `content/demos/investor/` are invented.

| Step | What happens | Code |
| --- | --- | --- |
| 1. Remember | Writes 24 files into a new Virtual User's memory | `server/demo/investor/memory-step.mjs`, `server/demo/services/memory.mjs` |
| 2. Learn the method | RSI learns a Recipe from two business plans and their recommendations | `server/demo/investor/method-step.mjs`, `server/demo/services/rsi.mjs` |
| 3. Analyze | A model reads the new plan with the Recipe and searches memory | `server/demo/investor/analyze.mjs`, `server/demo/services/llm.mjs` |

Sign-in is CoSens OAuth (authorization code with PKCE): `server/demo/oauth.mjs`. Every call uses the visitor's
own token, and each run creates a Virtual User in the visitor's account.

## Layout

- `apps/demo/`: the pages (TypeScript, Vite)
- `functions/`: Cloudflare Pages Functions (page gate and `/api/demo/*`)
- `server/demo/`: the calls to Memory, RSI, the model gateway and accounts
- `content/demos/investor/`: the demo documents
- `tests/`: run against fake services, no account needed

## Run it

```bash
npm install
npm run build
npm test
```

Serving it locally also needs a session secret and an OAuth client that allows your callback address; see
`.dev.vars.example`. The service addresses are in `wrangler.jsonc`. The CoSens OAuth client used by the
deployed site is registered for its own address only.

## API documentation

[cosens.ai/docs](https://cosens.ai/docs/)
