---
name: HearWhispers Review Desk
description: A private workspace for reviewing source conversations and preparing considered responses.
colors:
  background: "#ffffff"
  foreground: "#0a0a0a"
  primary: "#171717"
  primary-foreground: "#fff"
  sidebar: "#fafafa"
  sidebar-accent: "#f0f0f0"
  selected-row: "#f1f1f1"
  row-hover: "#f7f7f7"
  active-platform-text: "#171717"
  text-selection: "#dedede"
  muted: "#f5f5f5"
  muted-foreground: "#666666"
  border: "#e5e5e5"
  input: "#dedede"
  secondary: "#f5f5f5"
  secondary-foreground: "#171717"
  accent: "#f5f5f5"
  error-text: "#9c342c"
typography:
  headline: {fontFamily: '"Geist Variable", sans-serif', fontSize: "32px", fontWeight: 650, lineHeight: 1.2, letterSpacing: "-1.1px"}
  title: {fontFamily: '"Geist Variable", sans-serif', fontSize: "23px", fontWeight: 630, lineHeight: 1.3, letterSpacing: "-.6px"}
  quote: {fontFamily: '"Geist Variable", sans-serif', fontSize: "24px", fontWeight: 600, lineHeight: 1.3, letterSpacing: "-.5px"}
  body: {fontFamily: '"Geist Variable", sans-serif', fontSize: "15px", lineHeight: 1.7}
  label: {fontFamily: '"Geist Variable", sans-serif', fontSize: "14px", fontWeight: 500, lineHeight: 1.5}
rounded: {control: "6px", tab-tray: "7px", tab: "5px", icon: "8px"}
spacing: {small: "8px", control-gap: "12px", mobile-inset: "16px", intermediate-inset: "24px", desktop-inset: "36px"}
components:
  button-primary: {backgroundColor: "{colors.primary}", textColor: "{colors.primary-foreground}", rounded: "{rounded.control}", height: "40px", padding: "8px 16px"}
  button-outline: {backgroundColor: "{colors.background}", textColor: "{colors.foreground}", rounded: "{rounded.control}", height: "40px"}
  button-secondary: {backgroundColor: "{colors.secondary}", textColor: "{colors.secondary-foreground}", rounded: "{rounded.control}", height: "40px"}
  button-ghost: {backgroundColor: "transparent", textColor: "{colors.foreground}", rounded: "{rounded.control}", height: "40px"}
  draft-input: {backgroundColor: "{colors.primary-foreground}", textColor: "{colors.foreground}", rounded: "{rounded.control}", padding: "14px 16px"}
---

# Design System: HearWhispers Review Desk

## Overview

**Creative North Star: "Review Desk"**

The user-selected option 3 uses neutral white and gray surfaces, fine rules, compact navigation, and space for source evidence beside a response draft. It implements the approved `prototypes/hearwhispers-web/evidence/review-desk/desktop-final.png` with real shadcn/Radix sidebar-07 components and Lucide SVG icons. Geist is self-hosted; no shipping raster assets are used. This record supersedes the obsolete plain-CSS/password guidance and applies only to this web tracker. Product truth is in `opportunity-tracker/README.md`; the repository-root PRODUCT.md belongs to the separate iPhone app.

**Key Characteristics:**

- White canvas, a quiet sidebar, and a charcoal action color.
- A compact queue above source evidence and an editable draft.
- Explicit save states and focused mobile conversation review.

The earlier layout finish reviewer returned **ship**, with no material fixes. That review predates the monochrome palette update. Evidence is in `opportunity-tracker/.impeccable/review/{desktop,mobile,mobile-detail,login-mobile}.png`. Workspace captures use local fixture data; the login capture uses a fixture Google button, not the production provider rendering.

## Colors

On October 8, 2026, the user rejected both reddish clay and teal, and asked for colors grounded in HearWhispers’ brand. The existing landing page (`prototypes/hearwhispers-web/src/LandingPage.jsx` and its unscoped theme in `src/styles.css`) is the color reference: white, black/charcoal actions and typography, and soft gray borders and artwork. The tracker now follows that monochrome palette, retaining the Review Desk layout. Neither clay nor teal is an approved brand color.

The frontmatter records the implemented palette. The scoped Review Desk overrides in `opportunity-tracker/ui/src/styles.css` are authoritative. Charcoal marks the source action, source quote, selected-row rule, focus, and caret. White canvas and light gray sidebar separate work from navigation; muted fills and gray borders separate controls and metadata. Selected rows use light gray. Error text stays distinct. **The Selected Direction Rule.** The source and selected-row left rules belong to the user-pinned design and are explicit exceptions to the generic detector's side-tab ban.

## Typography

Geist Variable supplies every text role. Sentence-case headings and controls use weight and spacing for hierarchy. The source quote is the dominant reading element; metadata is generally 12–14px. At 540px and below, the page headline is 28px, pane titles and source quotes are 22px, and draft/product-form text is 16px. The login headline is 38px, reducing to 32px on phones.

## Layout

Desktop has a 240px sidebar (48px collapsed), a 72px header, and main padding of 32px 36px 40px. Search, product/platform filters, past-year progress, and status tabs precede a five-row paginated queue. Source and draft follow a horizontal divider in 1.15:1 tracks separated by a vertical rule. Quotes wrap at 30ch; fit copy at 65ch; the draft minimum height is 300px.

At 1350px the toolbar wraps and detail tracks become equal. At 1100px detail panes stack, horizontal page padding becomes 24px, and the draft minimum becomes 220px. At 900px and below, selecting a conversation hides the heading, filters, progress, queue, and pagination and focuses Source and context; All conversations restores the queue and returns focus to its row. Below 768px the sidebar opens as an 18rem modal sheet. At 540px page padding becomes 24px 16px, the header is 56px, search spans a row, metadata sits below each title, and source/draft actions are 44px high. Minimum body width is 320px. Product dialogs scroll within 90dvh and are at most 650px wide.

## Elevation & Depth

Content stays flat with tonal separation and fine rules. Outline buttons and inputs retain shadcn extra-small shadows; active status tabs have small shadows. The draft removes its shadow; dialogs and mobile sheets retain overlay elevation and a half-black backdrop. Charcoal outlines and component focus rings remain visible. Row hover transitions take 120ms and sidebar transitions 200ms linear; reduced motion reduces animation/transition duration to 0.01ms.

## Shapes

Desk controls have 6px corners, tab trays 7px, tabs 5px, and brand/product icon tiles 8px. Queue rows and content regions remain rectangular and ruled. The workspace storage label is a small bordered status label. The interface does not use independent elevated cards for each evidence section.

## Components

The sidebar has **HearWhispers** and **ActOnWhispers** groups. HearWhispers contains Conversations, Saved, Products, Listening, Insights and Research; ActOnWhispers contains Actions, Auto-draft replies and Videos & captions. Reply drafts open a separate view; post drafts remain in Actions. Both retain a shared edit buffer so saving one view preserves drafts in the other. Videos & captions is a placeholder for future videos created from templates with captions. Settings stays in the footer. A product switcher below the brand replaces the lower product shortcut list and duplicate selectors in individual views, maintaining one selected product across the tools. The header names the current group. No plan explanations or comparison page appear in the app. Semantic queue buttons expose selection and saved bookmarks. Platform filters cover Reddit, X, LinkedIn, and Other when present. Status tabs separate All active, New, and Dismissed; saved decisions also have a dedicated view. The filled charcoal action opens the original source; outline controls save/copy drafts; saved decisions use secondary fill; Dismiss and Check now use ghost controls.

Source context retains author/source/date, literal evidence, optional parent context, historical/closed status, and Potential fit. Draft status reads Not started, Unsaved changes, Saving…, Saved to your workspace, or Saved locally. Save draft explicitly persists via the item API and confirms with a Draft saved toast; failures appear inline. Notes have a separate Save note action. Unsaved draft/note buffers survive conversation and view switches in the mounted workspace; page exit warns and sign-out asks before discarding them. They are not guaranteed to survive refresh, browser termination, or session loss. Copy draft and Use this draft do not save or post responses. Nothing posts automatically.

Past-year progress uses disclosures with queries, coverage, limits, failures, and review counts. Reddit/X monitoring retains its two-hour cadence; enabled LinkedIn checks retain 8 a.m./8 p.m. Pacific. Research retains Problems/Landscape/People and explicit run/refresh actions. Settings retains private/local storage, allowances, AI review, backup, and cloud sign-out. Production uses Google-only allowlisted sign-in; local loopback access remains unauthenticated. Save feedback, status roles, alerts, accessible labels, and the skip link remain part of the components.

Source: `opportunity-tracker/ui/src/{App.jsx,WorkspaceViews.jsx,ProductEditor.jsx,Login.jsx,styles.css,api.js}`, `ui/src/components/hearwhispers-sidebar.jsx`, and `ui/src/components/ui/`. Contract: `opportunity-tracker/ui/index.html`. Build from the repository root with `npm run build:ui --prefix opportunity-tracker`; `opportunity-tracker/ui/vite.config.mjs` emits served `opportunity-tracker/public/index.html` and `opportunity-tracker/public/assets/`. Legacy `public/styles.css` and `public/app.js` are not the current interface authority.

## Do's and Don'ts

- **Do** preserve the approved palette, rules, evidence hierarchy, mobile focus behavior, and explicit save states.
- **Do** keep source provenance, coverage limits, errors, research, product setup, and backup controls inspectable.
- **Do** rebuild the committed frontend output after editing the source.
- **Don't** remove user-pinned left rules merely to satisfy a generic detector heuristic.
- **Don't** imply autosave, automatic posting, complete search coverage, or persistence of unsaved buffers after session loss.
- **Don't** revive password sign-in, the obsolete bare-CSS guidance, or treat fixtures as production evidence.
- **Don't** apply this tracker record to the separate iPhone product or change the root PRODUCT.md.

## Work-page refinement — October 8, 2026

The user requested consistent density, stronger action hierarchy and removal of obsolete version language across the dashboard, with the sidebar left unchanged. Work pages now share a 24px headline, 8px title-to-description gap, 24px header-to-content gap, 24px desktop inset (16px on phones), and a left-aligned content region capped at 1040px. Workflow sections use 20px vertical spacing and 17px headings; Products uses compact 16px rows; Settings aligns section labels with their controls and values. Research puts Run/Refresh research in its page header.

A filled charcoal button identifies the next available task. Add product leads only Products and no-product states. Workflow prerequisites link directly to the business profile, Listening, Insights or Actions; subsequent stage controls remain secondary until their prerequisites are satisfied. Editing a plan or draft gives its save action precedence. Current, unchanged plans cannot be reactivated accidentally. Empty and paused states provide a concise explanation and a relevant next step.

Product setup offers the current reviewed business breakdown, without a version switch. Search-plan activation uses the current API contract; legacy activation choices and all visible version labels are removed. Historical data and internal compatibility identifiers are retained. Profile review, search-phrase validation, explicit draft saves and unsaved-edit buffers remain required.

Validated against the shared port-50740 fixture and the existing disposable populated pipeline fixture, at desktop and phone widths. The UI build and 22 existing profile, pipeline and conversation-feed regression checks pass. This is local preview evidence; production publication remains with the integration chat.
