# Contributing to AdminDB

Thanks for considering a PR. This project is small and dependency-light, and we'd
like to keep it that way — a few guidelines help everyone move fast.

## Getting set up

Requires **Node.js ≥ 20**.

```bash
git clone https://github.com/MIbnEKhalid/admindb.git
cd admindb
npm install
```

## Development workflow

```bash
npm run dev        # tsx watch server + Tailwind watch (live reload)
npm test           # builds and runs the unit tests
npm run build      # TypeScript → dist + Tailwind CSS
```

`npm test` compiles TypeScript to `dist/` and runs the `node:test` suite
(`src/test/*.test.ts`) covering the SQL generator (INSERT / UPDATE / CREATE
output, type mapping, quoting, rejection of unsupported types), the SQL
classifier, CSV parsing and serialization, row filters (legacy and structured
conditions), the data generator / seeder, the database layer (pagination,
transactions, bulk update/delete, read-only enforcement), the database manager,
CLI argument parsing, and shared utilities.

## Project layout

- `src/app.ts` — Express app assembly, Handlebars engine + helpers, locals.
- `src/cli.ts` / `src/args.ts` — standalone server + CLI flag parsing.
- `src/db/` — `database.ts` (queries, filters, transactions), `manager.ts`
  (multi-database), `export.ts`.
- `src/routes/` — `pages.ts` (server-rendered pages), `api.ts` (JSON API),
  `databases.ts` (manager-mode file browser).
- `src/sql/` — `classifier.ts`, `generator.ts` (safe SQL generation).
- `src/data/generator.ts` — the seed data generator.
- `src/public/` — frontend: vanilla JS (`js/`), Tailwind/DaisyUI CSS (`css/`).
- `src/views/` — Handlebars templates (`layouts/`, `pages/`, `partials/`).

## Guidelines

- **Keep it dependency-light.** Prefer the standard library and the existing
  runtime deps (`express`, `express-handlebars`, `better-sqlite3`) over new
  packages.
- **SQL is generated, never interpolated.** Every identifier must be quoted and
  every string literal escaped when SQL is built — see `src/sql/`.
- **Read-only mode must stay enforced.** New write routes must return `403` in
  read-only mode and be kept out of the write-control UI. "Get query" / preview
  endpoints must never execute — they only return SQL strings.
- **Add tests.** New behaviour goes in `src/test/` so `npm test` covers it.
  Note: new files under `src/test/` may not show as untracked (see `.gitignore`)
  — stage them with `git add -f` if needed.
- **Update the docs.** User-visible changes belong in `README.md`; endpoint
  changes belong in `docs/API.md`.
- **Transactions for writes.** Multi-row operations (bulk update/delete, CSV
  import, seeding) run in a single transaction so a failed row rolls everything
  back.

## Opening a PR

1. Fork and branch off `main`.
2. Make your change, add/adjust tests, and run `npm test` until green.
3. Update `README.md` / `docs/API.md` where relevant.
4. Open the PR with a short description of what and why.

## License

By contributing you agree that your contributions are licensed under the
[MIT License](./LICENSE).
