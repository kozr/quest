---
name: Product tracker
description: A plain personal surface for reviewing product opportunities and mentions.
colors:
  background: "#fff"
  text: "#202020"
  link-focus: "#174a88"
  secondary-text: "#595959"
  divider: "#ccc"
  row-divider: "#ddd"
  control-border: "#aaa"
  button: "#f5f5f5"
  button-hover: "#e8e8e8"
  selected-button: "#e6e6e6"
  selected-border: "#303030"
  disabled-text: "#646464"
  disabled-button: "#f2f2f2"
  error: "#8d2020"
typography:
  body:
    fontFamily: "system-ui, sans-serif"
    fontSize: "16px"
    lineHeight: 1.5
  title:
    fontFamily: "system-ui, sans-serif"
    fontSize: "1.5rem"
  label:
    fontFamily: "system-ui, sans-serif"
    fontSize: ".875rem"
rounded:
  button: "3px"
  field: "2px"
spacing:
  base: "1rem"
  section: "1.5rem"
  columns: "2rem"
components:
  button:
    backgroundColor: "{colors.button}"
    textColor: "{colors.text}"
    rounded: "{rounded.button}"
    padding: ".35rem .7rem"
  field:
    backgroundColor: "{colors.background}"
    textColor: "{colors.text}"
    rounded: "{rounded.field}"
    padding: ".45rem .55rem"
---

# Design System: Product tracker

## Overview

Mode: Operate. This folder contains the personal web tracker for public opportunities and mentions of products represented by website or App Store URLs. It is separate from the repository's iPhone product. The hosted version adds a plain password form and sign-out button; the working surface stays the same. Its footer identifies private cloud storage; local mode identifies storage on this computer.

The user's direction remains bare CSS: a white page, dark system text, conventional controls, thin gray dividers, and underlined content links. No visual theme or named brand metaphor is established. The product list and filterable discussion feed are the working surface. The completed surface's reviewer verdict is **Ship**.

This record merges the direction contract with the current `public/index.html`, `public/styles.css`, and `public/app.js` implementation.

## Colors

Neutral colors provide the page, controls, dividers, and selected states. Blue identifies content links and keyboard focus. Secondary text identifies metadata and help; red identifies errors and the delete action. Token values above are the source of truth. The header's product name inherits the text color and omits an underline.

## Typography

All text and controls use the system font. The main heading uses the title size; section headings use (1.125rem), match titles use (1.0625rem), and form headings use (1rem). Help, metadata, filters, and secondary actions use the label size. Form labels have weight (600); selected buttons also have weight (600). Match snippets preserve line breaks and wrap long text.

## Layout

The main content is centered with a maximum width of (1400px) and section-sized padding. Desktop uses a (310px) product column and a flexible match column, separated by the column gap and a vertical divider. Match content has a minimum width of zero so it can shrink without forcing page overflow.

At widths of (780px) or less, the columns stack, page padding becomes the base spacing, and the product section ends with a horizontal divider. Product choices use an automatically fitting grid with a minimum column width of (180px). Header actions, status controls, filter fields, match actions, and source query links wrap. Long links and product names can break anywhere.

Match snippets are limited to (75ch), reasons to (80ch), and empty-state copy to (55ch). The add/edit form stays inline in the product section; backup restore appears above the workspace.

## Elevation & Depth

There are no shadows, gradients, overlays, or decorative layers. Thin borders separate products, matches, filters, and coverage records. Search coverage, exclusions, and notes use native disclosure controls.

## Shapes

Buttons and fields use the small radii declared above and a (1px) control border. Content rows remain open on the page, with dividers rather than card containers. Controls retain conventional rectangular shapes.

## Components

- **Buttons:** Minimum height (2.5rem). Hover changes the neutral background. Pressed product/status buttons use the selected background, darker border, and increased weight. Disabled controls use the disabled colors. Smaller edit actions have a minimum height of (2rem).
- **Fields:** Visible labels, full-width inputs and textareas, and vertically resizable textareas. Filter fields wrap, with the text filter allowed to grow. No custom select or file-picker replacement is used.
- **Focus:** A visible (2px) blue outline with a (3px) offset. A keyboard-accessible skip link leads to matches. The add/edit form focuses its URL field; cancel returns focus to Add product.
- **Matches:** Source/type/date metadata, an underlined source title, conversation snippet, match reason, review actions, and optional notes. Save, Dismiss, Restore to New, and Save note expose explicit text actions.
- **Feedback:** Loading and search progress use live status text; errors use an alert notice. Empty states explain the next action. Search coverage reports checked, unconfigured, and failed sources with source-search links.
- **Motion:** Only button background changes animate (100ms ease-out), and only when reduced motion is not requested.

## Do's and Don'ts

- **Do** preserve the plain controls, readable text, wrapping actions, and stacked mobile layout.
- **Do** keep each match linked to its original discussion and explain why it matched.
- **Do** expose search coverage, loading, failures, and empty states in text.
- **Do** preserve local save, dismiss, restore, notes, and backup controls.
- **Don't** add a visual theme, decoration, imagery, charts, or game language.
- **Don't** add sales or purchase tracking to this surface.
- **Don't** apply this folder's web design record to the separate iPhone product or change the repository-root `PRODUCT.md` from this workflow.
