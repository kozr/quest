# Prototype Instructions

## Color preference — October 8, 2026

- The user rejected reddish clay and teal and requested a palette grounded in HearWhispers’ brand. The landing page’s existing white, black/charcoal, and soft gray palette is the reference for dashboard colors. This supersedes the older clay-color guidance below; preserve the selected Review Desk layout.

## HearWhispers direction — October 7, 2026

- The product name is **HearWhispers**, exactly this capitalization. The project folder is `prototypes/hearwhispers-web`; code and storage use `hearwhispers`. Preserve existing preview data through `src/lib/preview-storage.js`, where legacy identifiers are retained only for migration.
- Copy must speak to independent builders, the value of turning a real problem into a useful product, why reaching early users matters, and how HearWhispers helps. Explain benefits in plain sentences; do not reduce the page to a feature inventory or invent a slogan. Use attributed public discussions for evidence, without presenting authors as customers or inventing conversion or time-saving claims.
- Public landing page: independently recreate the public Landing Page 4 layout with free shadcn components, as explicitly requested by the user after the Elite source gate was identified. Do not access or claim to have used the gated Elite source.
- Dashboard: use the official shadcn/ui sidebar components, with sidebar-07 as the navigation reference.
- The user selected dashboard option 3, **Review Desk**, on October 7, 2026. Its source of truth is `evidence/review-desk/selected-design.png`: a compact conversation queue above a two-column source/context and draft workspace, warm neutral surfaces, muted clay accent, and clear historical-example disclosure. Preserve this direction when refining the dashboard.
- No taglines, slogans, game language, or decorative marketing copy anywhere. Use product names, descriptive section labels, and necessary instructions.
- Preserve soft fine lines, gently squared controls, ample spacing, and the source component proportions.
- This is a self-contained local design preview. Keep production web, iPhone, backend, and opportunity-tracker files unchanged.
- Preview data and local-only persistence must be identified honestly. Never imply demo records are live results or saved to a real account.

Run the local server yourself and open the preview in the browser available to this environment. Do not give the user server-start instructions when you can run it.

Before making substantial visual changes, use the Product Design plugin's `get-context` skill when the visual source is unclear or no longer matches the current goal. When the user gives durable prototype-specific design feedback, preferences, or decisions, record them in `AGENTS.md`.

When implementing from a selected generated mock, treat that image as the source of truth for layout, component anatomy, density, spacing, color, typography, visible content, and hierarchy.

Build app UI in `src/`. Keep `.openai/hosting.json`, `worker/index.js`, `scripts/prepare-sites-build.mjs`, and `tests/sites-worker.test.mjs` intact so the same local prototype can be handed to Sites. Before a Sites handoff, run `npm run build` and `npm run test:sites`; the build must leave `dist/client/index.html`, `dist/server/index.js`, and `dist/.openai/hosting.json`.
