# contextbill web

The hosted version of contextbill, deployed at
[contextbill.vercel.app](https://contextbill.vercel.app). You pick your
`~/.claude/projects` folder in the browser, the page parses the transcripts locally, and
only aggregate figures are saved to your account: totals and per-category, per-model, and
per-session numbers. Prompts, completions, and raw transcript lines never leave the
browser.

Stack: Next.js 16, React 19, and Supabase for sign-in and storage, with row-level
security on every table.

## How it uses the core package

The parser and pricing code are the same ones the CLI runs. `tsconfig.json` maps
`@core/*` to `../dist/*` and `@prices` to `../prices.json`, and `lib/browser-scan.ts`
feeds picked files into the core `parseTranscript` and `aggregate`. A test in
`lib/__tests__/browser-scan.test.ts` checks that the browser reader and the CLI reader
produce identical aggregates for the same corpus.

| Path | Purpose |
| ---- | ------- |
| `app/page.tsx` | Landing page |
| `app/dashboard/new/page.tsx` | Folder picker and in-browser analysis |
| `app/dashboard/[id]/page.tsx` | A saved report, with per-report deletion |
| `app/privacy/page.tsx`, `app/terms/page.tsx` | Privacy policy and terms |
| `lib/browser-scan.ts` | Reads picked files, retries a failed read once, and lists files it could not read |
| `lib/supabase/` | Browser and server Supabase clients |

## Run it locally

From the repository root:

```bash
npm install                    # installs the core and this workspace
cp web/.env.example web/.env.local
npm run dev --workspace=web    # builds the core first, then starts Next on port 3000
```

Set `NEXT_PUBLIC_SUPABASE_URL` and `NEXT_PUBLIC_SUPABASE_ANON_KEY` in `.env.local`. The
key is the publishable key. The service-role key is not used anywhere in this app.

## Checks

```bash
npm test                       # from the root, includes the browser-scan tests
npm run lint --workspace=web
npm run build --workspace=web
```

## Deployment

Vercel builds this folder on every push to `main`. The project settings that make the
build work:

| Setting | Value |
| ------- | ----- |
| Root Directory | `web` |
| Include source files outside the Root Directory | enabled |
| Install Command | `npm --prefix .. install` |

There is no `vercel.json` at the repository root, and there should not be one.
