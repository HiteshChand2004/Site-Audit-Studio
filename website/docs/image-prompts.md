# AI image slots

One slot holds AI-generated images. Each is an empty, fixed-ratio box with a neutral fill until its file exists
(`components/ui/AiSlot.tsx` checks `public/`). Drop the file in at the exact path and rebuild: nothing else moves.
Sizes are CSS pixels as laid out; export at 2x for sharp screens. Format WebP, quality about 80.

| Slot | File | Where | Ratio | At 1440 | At 390 (350 on a phone) | Budget |
| --- | --- | --- | --- | --- | --- | --- |
| `about` | `public/ai/about.webp` | About page, beside "Four promises" | 4:3 | 588 × 441 (export 1176 × 882) | 335 × 251 (350 × 263) | 110 KB |

The hero is not an AI slot: its media slot (`heroMedia` in `lib/content.ts`) takes a video later. It is 16:9: 538 × 303 at
1440 and 333 × 187 at 390 (348 × 196 on a phone); export the video at 1920 × 1080.

## Shared style (paste at the start of every prompt)

> A calm, premium abstract still life in a light editorial style. Soft diffused daylight, matte paper and translucent
> frosted-glass layers, very shallow depth of field, generous empty space. Palette: warm off-white (#FAFAF7), pure white,
> deep near-black ink (#111111) and one accent of burnt orange (#C2410C), used sparingly. No text, no letters, no numbers,
> no logos, no people, no faces, no hands, no screens showing interfaces, no stock-photo feel. Clean, quiet, modern.

## `about` (4:3)

> [shared style] An overhead view of layered sheets of off-white paper offset like a fanned deck, one sheet edge in
> burnt orange, soft shadow on a pale warm background. Landscape 4:3.
