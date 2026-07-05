# Publishing a New Article — `npm run publish-article`

This is the one-command workflow for adding a new article to NateEatsHawaii.

You bring the content (page wrapper, translations, photos) from your app; the script
does **all the wiring** — schema validation, **face blur**, image watermarking +
optimization, a **face-free cover** pick, registering the article everywhere it needs
to appear, (optionally) creating the matching Food Map restaurant page, and the
**review star JSON-LD**. It's safe to re-run.

```bash
npm run publish-article          # auto-detects every new article you dropped in
# or target one:
npm run publish-article <slug>   # e.g. npm run publish-article pho-corner-ala-moana-review
npm run build                    # always build afterward to verify
```

---

## 1. What you drop in

For an article with slug `my-new-spot-review`, place these four things in the repo
(the slug is just the folder/file name — keep it identical everywhere):

```
app/[locale]/my-new-spot-review/page.tsx          # ~10-line wrapper (below)
translations/en/my-new-spot-review.json           # English content
translations/jp/my-new-spot-review.json           # Japanese content
public/images/articles/my-new-spot-review/*.webp  # the photos (.webp)
```

### The page wrapper (`page.tsx`)

Always the same 10 lines — only the `SLUG` changes. The script detects an article by
the fact that this file imports `ArticleTemplate`.

```tsx
import type { Locale } from "@/i18n.config"
import ArticleTemplate, { buildArticleMetadata } from "@/components/ArticleTemplate"

const SLUG = "my-new-spot-review"

export async function generateMetadata({ params }: { params: Promise<{ locale: Locale }> }) {
  const { locale } = await params
  return buildArticleMetadata(SLUG, locale)
}

export default function Page({ params }: { params: Promise<{ locale: Locale }> }) {
  return <ArticleTemplate slug={SLUG} params={params} />
}
```

### The translation files

These hold the actual article and render through `components/ArticleTemplate.tsx`.
The important part for automation is the `meta` block. A minimal EN example:

```jsonc
{
  "h1": "My New Spot Review: ...",
  "dek": "One-line summary shown in the hero + used as the SEO description fallback.",
  "byline": "By Nate · Updated June 2026 · prices verified in person",
  "intro": ["First paragraph...", "Second paragraph..."],
  "leadImage": {
    "src": "/images/articles/my-new-spot-review/hero.webp",
    "alt": "Descriptive alt text",
    "width": 480, "height": 640
  },
  "sections": [
    {
      "id": "what-to-order",
      "heading": "What to Order",
      "body": ["..."],
      "images": [
        { "src": "/images/articles/my-new-spot-review/dish.webp", "alt": "...", "caption": "..." }
      ]
    }
  ],
  "faq": { "heading": "FAQ", "items": [ { "q": "...", "a": "..." } ] },
  "verdict": { "heading": "Final Verdict", "body": ["..."] },

  "meta": {
    "slug": "my-new-spot-review",
    "title": "My New Spot Review (≤60 chars — the <title> tag)",
    "description": "SEO meta description, ~155 chars.",
    "keywords": ["keyword one", "keyword two"],
    "tags": ["honolulu", "vietnamese", "review"],
    "theme": "teal",
    "type": "review",
    "ogImage": "/images/articles/my-new-spot-review/hero.webp",
    "datePublished": "2026-06-15T00:00:00.000Z",
    "dateModified": "2026-06-15T00:00:00.000Z",

    "restaurant": {
      "slug": "my-new-spot",
      "name": "My New Spot",
      "address": "123 Example St, Honolulu, HI 96814, USA",
      "lat": 21.2975, "lng": -157.8385,
      "cuisine_types": ["Vietnamese", "Banh Mi"],
      "primary_type": "Vietnamese",
      "neighborhood": "Ala Moana",
      "opening_hours": "Monday: 11:00 AM – 9:00 PM | Tuesday: 11:00 AM – 9:00 PM",
      "price_level": 2
    }
  }
}
```

The JP file is the same shape with Japanese strings. (Its `meta.restaurant` block is
optional — the EN one is what creates the restaurant.)

#### `meta` field cheat-sheet

| Field | Required | Used for |
|---|---|---|
| `slug` | ✅ | Must equal the folder/file name. |
| `title` | recommended | The `<title>` tag (keep ≤60 chars). Falls back to `h1`. |
| `description` | recommended | SEO meta description. Falls back to `dek`. |
| `keywords` | optional | `<meta keywords>`. |
| `tags` | **recommended** | Powers the homepage Latest matching + related-articles. Without it the article still publishes, just untagged. |
| `theme` | optional | Hero color: `teal` (default), `purple`, `amber`, or `red`. |
| `type` | recommended | `"review"` → category **Review**; anything else → **Guide**. |
| `ogImage` | ✅ | Social/share image + the card image in lists. |
| `datePublished` / `dateModified` | recommended | `dateModified` (date part) becomes `lastUpdated`, which controls Latest + announcement-bar ordering. |
| `restaurant` | optional | Connects the article to a Food Map page + the in-article CTA. **To link an existing spot:** just `{ "slug": "<existing-slug>" }` (or match by `name`). **To create a new one:** full `slug`, `name`, `address`, `lat`, `lng`. The article's `menuTable` is copied to the restaurant's menu either way. Stripped from the shipped file afterward. |
| `rating` | optional | A number like `4.5` → generates the review **star JSON-LD** (only for `type: "review"`). Omit to skip. |
| `keepFaces` | optional | Array of image filenames where **your** face should be kept (the largest face stays, everyone else is blurred) — e.g. `["man-holding.webp"]`. Other images blur **all** faces. These photos are also kept **out of the Food Map restaurant gallery** (no selfie on the restaurant page). |
| `reviewBody` | optional | One-sentence summary for the review JSON-LD. Falls back to `dek`. |
| `preWatermarked` / `foodMapSlug` | — | **Don't set these by hand** — the script sets them. |

### The photos

- Format: **`.webp`**, named exactly as referenced in the JSON (`leadImage.src`,
  section `images[].src`, `meta.ogImage`). Use descriptive, hyphenated, keyword-rich
  filenames for image SEO (e.g. `chicken-banh-mi-vietnamese-iced-coffee.webp`).
- The script resizes and watermarks them — you do **not** need to pre-size or watermark.
  Bring the best-quality originals you have.

---

## 2. Run it

```bash
npm run publish-article
```

With **no argument** it scans `app/[locale]/*` and processes every article that
(a) uses `ArticleTemplate`, (b) has both EN + JP translations, and (c) isn't registered
yet. Drop in several articles, run once, done.

To target a single article (or force a re-run):

```bash
npm run publish-article my-new-spot-review
```

Preview without writing anything:

```bash
npm run publish-article my-new-spot-review -- --dry-run   # the `--` is required so npm passes the flag through
```

Then **always**:

```bash
npm run build
```

---

## 3. What it does automatically

0. **Schema validation** — checks the EN JSON against the flat `ArticleTemplate` shape
   and **hard-stops** that article (without publishing it) if it's wrong — e.g. it uses
   `hero.heading` instead of `h1` (the "renders with no title" bug), a bare `faq` array
   instead of `faq.items[]`, `quickReference.rows[]`, or a section-nested `menuTable`.
   Also warns if `meta.title` > 60 chars.

1. **Face blur + images** — for every `.webp`: **blurs every detected face** (privacy),
   *keeping* the largest face in any image listed in `meta.keepFaces` (your selfie);
   then auto-rotates, resizes to a max of **1000px**, bakes the **NateEatsHawaii logo**
   (bottom-right), compresses **under 200KB**, writes EXIF copyright, and sets
   `meta.preWatermarked`. Already-watermarked files are skipped.
   *Face blur is **best-effort*** — see Requirements below. Review the result: crowd
   shots can miss a distant face, and food close-ups can pick up a stray blur (re-drop
   the original to redo, or tune `SCORE` in `scripts/detect-faces.py`).

2. **Face-free cover** — if `meta.ogImage` is unset or still contains a face, it's
   swapped for the first face-free article image (lead image, then section images).

3. **Registration** in `lib/articles.ts` — inserts the article at the top
   (newest-first) of:
   - `ARTICLE_LIBRARY` (master index → `/articles`, search, related articles)
   - `ARTICLE_HIGHLIGHTS` (homepage feed)
   - `ARTICLE_JP` (Japanese titles/descriptions — the `/jp` homepage cards read this)

   This single step cascades to several places **with no extra work**:
   - 🏠 **Homepage "Latest"** picks it up (sorted by `lastUpdated`), EN and JP.
   - 📣 **Announcement bar** auto-features the newest article by `lastUpdated`.
   - 🗺️ **Sitemap** (`app/sitemap.ts`) auto-includes every `ARTICLE_LIBRARY` route.

4. **Food Map restaurant** — connects the article to a restaurant page and sets
   `meta.foodMapSlug` so the article shows the "See this spot on the Food Map" CTA:
   - **If a matching restaurant already exists** (matched by `meta.restaurant.slug` /
     `meta.foodMapSlug`, or by exact `meta.restaurant.name`) → **links to it**: writes
     the article back-link (`article_url` + `article_image`), merges the article photos
     into its gallery, and adds the **menu** — no duplicate is created.
   - **Otherwise, if `meta.restaurant` has full data** (`slug`, `name`, `address`,
     `lat`, `lng`) → **creates** `/food-map/<restaurant.slug>` (gallery + menu + back-link).
   - The article's **full menu** (`menuTable`) is copied to the restaurant's `menu`
     and rendered as a "Menu & Prices" section on the Food Map page.
   To link to an existing spot you only need `"restaurant": { "slug": "<existing-slug>" }`.

5. **Review star JSON-LD** — for `type: "review"` articles with a `meta.rating`,
   generates `schemaExtra.review` (author = Nate, `itemReviewed` = the restaurant,
   `reviewRating`) into the EN + JP JSON → eligible for ⭐ review rich-results.

### Requirements (face features only)

Blur + cover-pick need **`python3` + `opencv-python` + `numpy` + `Pillow`** (the YuNet
model auto-downloads once to `scripts/.cache/`). If any are missing, the script prints a
warning and **skips the face steps** — everything else still runs. To install:
`pip install opencv-python numpy Pillow`. Pass `--no-blur` to skip face steps on purpose.

---

## 4. Verify

```bash
npm run build
```

Look for `✓ Generating static pages` with no errors, and that your new routes appear:
`/en/<slug>`, `/jp/<slug>`, and (if you added a restaurant) `/en/food-map/<restaurant-slug>`.

Spot-check locally with `npm run dev`:
- the article page renders with images + the watermark logo,
- the homepage "Latest" and the top announcement bar show the new article,
- the Food Map CTA links to the restaurant, and the restaurant page links back.

---

## 5. Re-running / updating

The script is **idempotent**:

- **Images** already carrying the logo (EXIF marker) are skipped — no double watermark.
- An article already in `ARTICLE_LIBRARY` is skipped — no duplicate entries.
- A restaurant slug that already exists is skipped.

So if you add more photos later, or re-drop files, just run it again — it only does the
new work. To **replace** a photo, overwrite the `.webp` with a fresh (un-watermarked)
original and re-run; the new file (different bytes) gets re-processed.

---

## 6. Troubleshooting

| Symptom | Cause / fix |
|---|---|
| `anchor not found: // @publish-article:...` | Someone deleted an anchor comment in `lib/articles.ts`. Restore the `// @publish-article:library`, `:highlights`, and `:jp` comments. |
| Article not auto-detected | It must use `ArticleTemplate` in `page.tsx`, have **both** EN+JP JSON, and not already be registered. Otherwise pass the slug explicitly. |
| No Food Map link / CTA on the article | Add a `meta.restaurant` block and re-run: `{ "slug": "<existing-slug>" }` to link an existing spot, or the full block (`slug`, `name`, `address`, `lat`, `lng`) to create one. |
| Menu not showing on the Food Map page | The article needs a top-level `menuTable` with rows; re-run so it's copied to the restaurant's `menu`. |
| A photo wasn't watermarked | It already had the EXIF logo marker (treated as done). Replace with a raw original to force re-processing. |
| An image is still > 200KB | The script lowers quality until it fits; an extremely detailed photo may need a higher-quality source or a manual pass. |
| Build fails on the new page | Usually invalid JSON or a `src` pointing at a file that isn't in the folder. Validate the JSON and confirm every referenced `.webp` exists. |

---

## 7. What it does NOT do

- It doesn't write your content — you supply the EN/JP JSON (and the JP translation).
- It doesn't run `npm run build` for you.
- It can't invent a restaurant's real address/coordinates — supply those in
  `meta.restaurant`, and the review score in `meta.rating` (the manual data a new
  article needs).
- Face blur is **best-effort, not a guarantee** — always eyeball the processed images
  before shipping (a distant face can be missed; a food close-up can be over-blurred).

---

## Related

- Article rendering + full JSON schema: `components/ArticleTemplate.tsx`
- Article registry: `lib/articles.ts`
- Announcement bar (auto-features newest): `components/announcement-bar.tsx`
- Restaurant pages: `app/[locale]/food-map/[id]/page.tsx` + `public/data/custom-restaurants.json`
- The script itself: `scripts/publish-article.mjs`

