# Quest design direction — September 13, 2026

This records the user's decisions from the design conversation. It is the brief for future Quest exploration, not a claim that the concepts are implemented or ready to ship. The repository's root `DESIGN.md` describes the existing native app baseline. Discuss design changes with the user before implementation; selecting a visual direction does not authorize a full app rewrite.

## Confirmed direction

- Turn returning to discover new sales into opening a treasure chest. The intended emotion is excitement, discovery, and earned achievement.
- Use a bright daylight adventure world: sunny mountains, vivid greenery, warm stone, red banners, and gold highlights. Midnight or wind-down lighting is not the chosen overall direction.
- Preserve the seamless blend from foreground scenery and shadows into the dark navy interface. Navy is the foreground/interface base, not a requirement for a nighttime world.
- Keep the chest central. Sales emerge from it like RPG loot.
- The user selected the compact inventory-slot reveal (option 3 of the RPG loot set): small square framed app icons above the chest, amounts, and a compact selected-item detail.
- Oversized portrait collectible cards, ornate medallions, and generic large cream panels were rejected. Do not return to those directions without new user input.
- Consistency matters: reusable chest geometry, fixed proportions, a real lid hinge, stable materials, camera, and lighting rules. Repeated image generation is visual exploration, not proof of asset consistency.
- Apple Design Award 2027 is an ambition, not an established outcome or a reason to promise a winning visual style.

## Latest visual explorations

These three images were generated with the built-in image-generation tool and shown together as connected screens, not competing options. They extend the selected loot-slot direction into daylight. They have not received detailed final approval; the Activity header was identified as a candidate to shrink.

- [Ready to open](daylight-ready.png): reference for sunlit world, central chest, and foreground transition.
- [Loot revealed](daylight-loot.png): reference for compact slots and selected-sale details in daylight.
- [Activity](daylight-activity.png): exploratory application of the theme to transaction history.

Mock app artwork, amounts, and transactions are sample data. Generated chest geometry, layouts, and typography drift between images; do not treat the images as interchangeable frames of a finished animation. Real app icons should remain recognizable in production.

Prompt intent: create three mobile app screens at a logical 390 × 844 viewport; combine the selected RPG slot composition with the earlier sunny mountain reference; retain the navy foreground blend; use small framed icons and clear native data typography; exclude oversized cards, fake rarity/XP, and nighttime lighting. Each screen was generated independently with the actual reference images attached.

## Proposed, not yet approved or validated

- A reusable modeled chest with a fixed or layered mountain backdrop; rendering approach still requires a representative device prototype.
- Brief scenery dimming during the reveal, followed by restored daylight.
- Short-lived trails, light, sound, and haptics that settle after the reveal.
- A restrained serif for short adventure headings and native sans-serif for data and controls.
- Direct Activity access and an optional reveal-all path.
- World growth at real sales milestones was discussed as a question. The user has not selected it; do not invent progression, currencies, rarity, or levels.

## Accuracy and consistency workflow

1. A reference researcher documents actual RPG loot screens and reveal sequences, with captured evidence and a distinction between observation and proposed adaptation.
2. One art director owns this brief, approved references, tokens, and asset rules, resolving conflicts before production work.
3. An asset specialist creates reusable geometry, materials, icon frames, and camera/light presets.
4. An interface and motion specialist composes the same assets and components into interactive states, including long text, many sales, no sales, and reduced motion.
5. An independent reviewer compares actual rendered states with the agreed references and checks visual drift, readable data, accessibility, and device performance.

The existing `TreasureView.swift` is an unfinished draft outside the active Xcode source target. The two treasure image sets are incomplete and currently produce unassigned-image warnings. The separate SceneKit study demonstrates geometry reuse; it does not establish production visual fidelity or iPhone performance. See [the earlier agent review](../agent-review.md) for the research and production limitations.
