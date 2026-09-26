# iOS 1.0.2 (29)

Restores build 26’s page headers, app selectors, spacing, and Market wood/parchment treatment while retaining the Landscape tab and Reddit People matching, resolution, coverage, and evidence labels introduced afterward. The original Problems research instructions remain unchanged.

All six restored design source files matched build 26’s recorded SHA-256 hashes before the Market feature patches were reapplied. Compared with build 26, the resulting release inputs differ only in four Market files and the build number. The app and notification extension use build 29.

The native app foundation and layout work were checkpointed on main before this restoration commit. This release restores the build 26 design on top of that history and retains the Market features. Backend changes are outside this native release commit.

Release evidence is stored locally in `test-results/build29-upload/`. The signed archive was built from commit `05a4102fce56eaaf5db6971a12f811fa3411e93c`, verified on GitHub main before upload. No App Review submission is part of this release.

Validation before archiving: isolated simulator build, all five default main-page renders, compiled Market model checks for legacy/current decoding, and the layout scan passed. The earlier XCTest runner startup limitation remains; no new XCTest pass is claimed.

Upload completed September 25, 2026 at 5:15 PM PDT. Xcode reported **Upload succeeded** and **EXPORT SUCCEEDED**. Both bundle versions/signatures and all 61 source hashes passed verification before and after upload; bundled artwork matches build 26 exactly. Apple reports the uploaded package processing; the immediate API check had not listed build 29 yet.
