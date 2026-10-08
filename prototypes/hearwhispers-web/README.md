# HearWhispers web preview

A local, responsive landing page and dashboard using React, Tailwind, and official shadcn/ui components. No taglines.

The project lives in `prototypes/hearwhispers-web`, uses the `hearwhispers-web` package name and `hearwhispers` example-product ID, and saves preview state under `hearwhispers-preview-v1`. Existing preview data is imported from the legacy storage entry on first load; that entry is retained as a backup. Current HearWhispers data takes precedence.

## Preview

- Landing page: http://127.0.0.1:4173/#home
- Dashboard: http://127.0.0.1:4173/#conversations

`npm run dev -- --host 127.0.0.1 --port 4173 --strictPort` starts the preview. `npm run build` creates the production bundle. `npm run test:preview` verifies preview-data migration.

## Design sources

- [Shadcnblocks Landing Page 4](https://www.shadcnblocks.com/page/landing-page4): independently recreated from its published visual reference, per the user's instruction to use free shadcn components. No gated Elite code was accessed or used.
- [Published reference screenshot](https://cdn.shadcnblocks.com/shadcnblocks/screenshots/page/landing-page4-4x3.webp): saved in `evidence/landing-page4-source.webp`. The four decorative line images in `public/assets/` are crops of this reference; their resolution is limited by that public screenshot.
- [Official shadcn/ui sidebar-07](https://ui.shadcn.com/blocks/sidebar#sidebar-07): installed through the official registry. App navigation uses its actual Sidebar primitives, including icon collapse and mobile Sheet.
- Icons: Lucide. Typeface: Geist, served locally.
- `public/assets/dashboard-preview.jpg` is a browser screenshot of this implemented dashboard.

The original template's marketing headline, customer logos, testimonials, and pricing are replaced with the product name, functional descriptions, one attributed historical discussion, and an actual dashboard preview. No endorsements or customer claims are implied.

## Dashboard direction

The user selected the Review Desk design on October 7, 2026: a compact conversation queue above source/context and draft-response columns, with warm neutral surfaces and a restrained clay accent. The exact source is `evidence/review-desk/selected-design.png`; current desktop/mobile captures and comparisons are in the same folder. The sidebar remains the official shadcn/ui implementation. On narrow screens the list opens a focused, vertically stacked review view.

## Working interactions

Navigation, product filtering, text search, saved conversations, dismiss/restore, draft editing and copying, and product forms are functional. Review status, drafts, and products persist in this browser's local storage. Undo is available after mutations.

The two historical public Reddit discussions in `src/data.js` are examples, not live results. Live discovery, account authentication, and backend persistence are not connected. This folder is independent of the existing production apps.

See `design-qa.md` for verification and screenshot evidence.
