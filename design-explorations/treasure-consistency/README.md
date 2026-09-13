# Quest treasure consistency study

A source-authored 3D proof of the proposed miniature adventure direction. This is an art study, not an app integration or a final art-quality claim. No image generation is used for these renders.

## Review

- `renders/comparison.png`: the same chest in 3 poses across 3 settings.
- `renders/opening.mp4`: the real hinged opening, rendered at 30 fps.
- `renders/opening.gif`: inline animation preview.
- `renders/quest-chest.scn`: reusable master chest with separately named lid hinge.
- `renders/quest-chest.dae`: interchange export; verify materials when importing into a different renderer.
- `renders/consistency-report.json`: geometry/material fingerprint for every state, camera and lighting parameters, and the result of rendering the same reference twice.

## Locked art rules

- One navy chest: same dimensions, bands, rivets, feet, keyhole, hallmark and coins in all renders.
- Faceted geometry and chamfered edges; no procedural or generated image textures.
- Shared named matte materials; midnight enamel, warm brass, forest green and ivory stone.
- Fixed orthographic camera, framing, key light and ambient fill. Exposure adaptation is off.
- Surrounding props do not cast differing shadows onto the chest; the lid's own shading changes naturally as it rotates.
- Only `Lid hinge — the only animated transform` changes: 0°, 45° or 100°.
- Forest, ruins and coast are modular surroundings, separate from the master chest.

## Reproduce on macOS

Requires Xcode command-line tools, a Metal-capable local GPU and FFmpeg for movie/GIF packaging. Run from this directory:

```sh
xcrun swiftc -module-cache-path /private/tmp/quest-swift-module-cache render.swift -o /private/tmp/quest-treasure-render
/private/tmp/quest-treasure-render renders
xcrun swiftc -module-cache-path /private/tmp/quest-swift-module-cache board.swift -o /private/tmp/quest-treasure-board
/private/tmp/quest-treasure-board renders
ffmpeg -y -framerate 30 -i renders/frames/%03d.png -c:v libx264 -pix_fmt yuv420p -movflags +faststart renders/opening.mp4
ffmpeg -y -framerate 30 -i renders/frames/%03d.png -filter_complex 'fps=20,scale=520:-1:flags=lanczos,split[a][b];[a]palettegen[p];[b][p]paletteuse' -loop 0 renders/opening.gif
```

The fingerprints validate invariant geometry and material properties within this study. They exclude the intentional lid transform. The repeated PNG check establishes repeatability on this machine and renderer, not pixel identity across different GPUs, OS versions or export formats. Image generation would still need human review for any newly proposed asset; accepted assets should enter this shared model/material library.

SceneKit is used here as a readily available local renderer. Choosing the shipping iPhone rendering system is outside this study.
