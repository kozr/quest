# Main-page alignment

Leads, Market, Apps, and Settings now use `QuestMainPageHeader`: the same safe-area position, scaled title/icon row, 16-point page margins, subtitle slot, and landscape treatment. Headers stay visible as content scrolls. Activity intentionally keeps its original compact header, Demo pill, and uninterrupted landscape/chest composition. Leads and Market use their concise tab names so page actions do not force different title heights.

Leads and Market share `QuestAppPickerLabel` and matching default board positions. Both use a 16-point gap before their section controls and before their board. The Leads section heading sits above its board, parallel to Market’s Problems/People controls. Market’s wooden board now uses the same outer margins as Leads. Both render `QuestBoardBackground`, using the exact same stretchable `LeadsSharedBoard` asset, parchment, wood edges, and brass bookmark. Market’s Problems, research, People, and message boards also use matching 29-point horizontal and 26-point vertical content insets. Settings keeps its native Form with its page heading outside the first section.

Validation: production Debug simulator build and isolated offline preview build passed on the compact 375 × 667-point iPhone simulator. All five default and accessibility-3 captures were inspected. The four utility-page headers, selectors, and board edges align. At accessibility sizes, app selectors grow equally, and content can wrap and scroll; section content heights may differ. Market’s scroll content is explicitly bounded to the viewport to prevent horizontal overflow. No upload or deployment was performed.

Captures: [default](default.png), [accessibility](accessibility.png). Individual full-resolution captures are in the matching folders.

Reproduce using `python3 design-explorations/main-page-headers/create-preview.py`, build the generated preview project, and launch `com.kozr.quest.headerspreview` (or append `--large-text`). The isolated app writes all five screenshots to its `tmp/main-page-headers` directory. Production launch behavior is unchanged.
