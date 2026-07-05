#!/usr/bin/env node
/**
 * publish-article — automate everything around a new article.
 *
 * You bring (from your app, on any machine):
 *   - app/[locale]/<slug>/page.tsx        (the ~10-line ArticleTemplate wrapper)
 *   - translations/en/<slug>.json         (article content, ArticleTemplate schema)
 *   - translations/jp/<slug>.json
 *   - public/images/articles/<slug>/*.webp
 *
 * Then run:  npm run publish-article <slug>
 *        or: npm run publish-article         (auto-detects every dropped-in,
 *                                             not-yet-registered article)
 *
 * It then does the same wiring as every existing article, all idempotent:
 *   0. Validates the JSON against the flat ArticleTemplate schema — hard-stops a
 *      wrong-shape article (e.g. `hero.heading` instead of `h1`) before it ships
 *      broken, and warns on a >60-char SEO title.
 *   1. Face blur (best-effort) + watermark + optimize every .webp: blurs every
 *      detected face (privacy) — keeping the largest face in any image listed in
 *      meta.keepFaces (your selfie) — then bakes the Nate logo, resizes ≤1000px,
 *      compresses <200KB, writes EXIF. Skips files already watermarked, so re-runs
 *      are safe. Face steps need python3 + opencv (scripts/detect-faces.py); if
 *      absent they're skipped with a warning (the rest still runs).
 *   2. Picks a face-free meta.ogImage (cover) if it's unset or contains a face.
 *   3. Registers the article in ARTICLE_LIBRARY + ARTICLE_HIGHLIGHTS + ARTICLE_JP
 *      (lib/articles.ts) at the top (newest-first) — which also auto-updates the
 *      homepage "Latest" (JP cards too, via ARTICLE_JP), the announcement bar, and
 *      the sitemap.
 *   4. Connects the article to a Food Map restaurant + sets meta.foodMapSlug (the
 *      "See this spot on the Food Map" CTA): LINKS to an existing restaurant when one
 *      matches (by meta.restaurant.slug / meta.foodMapSlug, or exact name) — writing the
 *      article back-link, merging photos, and adding the menu — otherwise CREATES a new
 *      /food-map/<slug> from a full meta.restaurant block. The article's menuTable is
 *      copied to the restaurant's `menu` and shown as a "Menu & Prices" section.
 *   5. For type:"review" articles with a meta.rating, generates schemaExtra.review
 *      (critic Review JSON-LD → ⭐ rich-result eligibility) into the EN+JP JSON.
 *
 * Flags: --dry-run (print planned changes, write nothing)
 *        --no-blur  (skip face blur + cover-pick)
 *
 * NOTE: run `npm run build` afterward to verify. This script never builds.
 */
import sharp from "sharp"
import { promises as fs } from "fs"
import path from "path"
import os from "os"
import { spawnSync } from "child_process"

const ROOT = process.cwd()
const DRY = process.argv.includes("--dry-run")
const BLUR = !process.argv.includes("--no-blur")   // face blur + cover-pick (best-effort; --no-blur to skip)
const argSlugs = process.argv.slice(2).filter((a) => !a.startsWith("--"))

// ---------- face detection (best-effort, via scripts/detect-faces.py) ----------
const FACE_SCRIPT = path.join(ROOT, "scripts/detect-faces.py")
let faceDisabled = !BLUR
// Run the Python helper. Returns parsed JSON, or null if face tooling is
// unavailable / errors — callers then skip face steps without failing publish.
function runFace(args) {
  if (faceDisabled) return null
  const r = spawnSync("python3", [FACE_SCRIPT, ...args], { encoding: "utf8", maxBuffer: 16 * 1024 * 1024 })
  // status 3 (deps/model missing) or spawn error → disable for the rest of the run
  if (r.error || r.status === 3 || r.status === null) {
    const why = (r.stderr || r.error?.message || "").toString().trim().split("\n").pop() || "python3 not available"
    log(`  ⚠ face tooling unavailable — skipping blur/cover (${why})`)
    faceDisabled = true
    return null
  }
  if (r.status !== 0) { log(`  ⚠ face step failed: ${(r.stderr || "").trim().split("\n").pop()}`); return null }
  try { return JSON.parse((r.stdout || "").trim()) } catch { return null }
}
const publicFile = (src) => path.join(ROOT, "public", String(src).replace(/^\//, ""))

const ARTICLES_TS = path.join(ROOT, "lib/articles.ts")
const CUSTOM_RESTAURANTS = path.join(ROOT, "public/data/custom-restaurants.json")
const WATERMARK_PATH = path.join(ROOT, "public/favicon-96x96.png")
const LOCALE_DIR = path.join(ROOT, "app/[locale]")

const WATERMARK_SIZE = 120
const WATERMARK_MARGIN = 60
const MAX_WIDTH = 1000
const MAX_BYTES = 195 * 1024
const EXIF_MARK = "NateEatsHawaii"

const log = (...a) => console.log(...a)
const enPath = (slug) => path.join(ROOT, "translations/en", `${slug}.json`)
const jpPath = (slug) => path.join(ROOT, "translations/jp", `${slug}.json`)
const imgDir = (slug) => path.join(ROOT, "public/images/articles", slug)

async function exists(p) { try { await fs.access(p); return true } catch { return false } }
async function readJson(p) { return JSON.parse(await fs.readFile(p, "utf8")) }
async function writeJson(p, obj) { await fs.writeFile(p, JSON.stringify(obj, null, 2) + "\n") }

// ---------- 1. images: watermark + optimize (idempotent via EXIF marker) ----------
let badgeCache
async function buildBadge() {
  if (badgeCache) return badgeCache
  const r = WATERMARK_SIZE / 2
  const mask = Buffer.from(
    `<svg width="${WATERMARK_SIZE}" height="${WATERMARK_SIZE}"><circle cx="${r}" cy="${r}" r="${r}" fill="white"/></svg>`
  )
  badgeCache = await sharp(WATERMARK_PATH)
    .resize(WATERMARK_SIZE, WATERMARK_SIZE, { fit: "cover", background: { r: 0, g: 0, b: 0, alpha: 0 } })
    .composite([{ input: mask, blend: "dest-in" }])
    .png()
    .toBuffer()
  return badgeCache
}

async function processImages(slug, en) {
  const dir = imgDir(slug)
  if (!(await exists(dir))) { log(`  ⚠ no image folder ${path.relative(ROOT, dir)} — skipping images`); return 0 }
  const files = (await fs.readdir(dir)).filter((f) => f.toLowerCase().endsWith(".webp"))
  if (!files.length) { log("  ⚠ no .webp images found"); return 0 }
  // Images whose subject (you) should NOT be blurred: keep the largest face, blur the rest.
  const keepFaceSet = new Set((en?.meta?.keepFaces || []).map((s) => path.basename(s).toLowerCase()))
  const badge = await buildBadge()
  let processed = 0
  for (const f of files) {
    const p = path.join(dir, f)
    let src = await fs.readFile(p)
    const meta = await sharp(src).metadata()
    const already = meta.exif && meta.exif.toString("latin1").includes(EXIF_MARK)
    if (already) { log(`  • ${f}: already watermarked — skip`); continue }

    // Face blur (best-effort) on the raw image, BEFORE the logo badge is stamped.
    // Blurs every detected face; if this file is listed in meta.keepFaces, the
    // single largest face (the subject) is kept and only others are blurred.
    if (BLUR && !faceDisabled) {
      const tmpIn = path.join(os.tmpdir(), `paf-in-${f}`)
      const tmpOut = path.join(os.tmpdir(), `paf-out-${f}.png`)  // lossless intermediate → no double webp loss
      await fs.writeFile(tmpIn, src)
      const res = runFace(["blur", tmpIn, tmpOut, ...(keepFaceSet.has(f.toLowerCase()) ? ["--keep-largest"] : [])])
      if (res && (await exists(tmpOut))) {
        src = await fs.readFile(tmpOut)
        if (res.blurred || res.kept) log(`  • ${f}: blurred ${res.blurred} face(s)${res.kept ? ` (kept subject)` : ""}${DRY ? " (dry)" : ""}`)
      }
      await fs.rm(tmpIn, { force: true }).catch(() => {})
      await fs.rm(tmpOut, { force: true }).catch(() => {})
    }

    let pipe = sharp(src).rotate()
    if ((meta.width || 0) > MAX_WIDTH) pipe = pipe.resize(MAX_WIDTH)
    const resized = await pipe.toBuffer()
    const rmeta = await sharp(resized).metadata()
    const left = Math.max(0, (rmeta.width || MAX_WIDTH) - WATERMARK_SIZE - WATERMARK_MARGIN)
    const top = Math.max(0, (rmeta.height || MAX_WIDTH) - WATERMARK_SIZE - WATERMARK_MARGIN)
    let out, q = 82
    do {
      q -= 2
      out = await sharp(resized)
        .composite([{ input: badge, left, top, blend: "over" }])
        .withExif({ IFD0: { Artist: EXIF_MARK, Copyright: `© ${EXIF_MARK}`, ImageDescription: `Photo by ${EXIF_MARK}` } })
        .webp({ quality: q, effort: 4 })
        .toBuffer()
    } while (out.length > MAX_BYTES && q > 38)
    if (!DRY) await fs.writeFile(p, out)
    log(`  • ${f}: ${(out.length / 1024 | 0)}KB q${q} ${rmeta.width}x${rmeta.height} ${DRY ? "(dry)" : "✓ watermarked"}`)
    processed++
  }
  return processed
}

// ---------- helpers to read article meta ----------
// Basenames of the author's own-face photos (meta.keepFaces) — kept out of the
// restaurant gallery so the Food Map page never leads with a selfie.
function keepFaceBasenames(en) {
  return new Set((en?.meta?.keepFaces || []).map((s) => path.basename(s).toLowerCase()))
}
function imagesFromArticle(en) {
  const keep = keepFaceBasenames(en)
  const out = []
  if (en.leadImage?.src) out.push(en.leadImage.src)
  for (const sec of en.sections || []) for (const im of sec.images || []) if (im.src) out.push(im.src)
  return [...new Set(out)].filter((src) => !keep.has(path.basename(src).toLowerCase()))
}

// ---------- 2. register in lib/articles.ts ----------
function insertAfterAnchor(text, anchor, block) {
  const idx = text.indexOf(anchor)
  if (idx === -1) throw new Error(`anchor not found: ${anchor} (did someone remove the // @publish-article comment?)`)
  const lineEnd = text.indexOf("\n", idx)
  return text.slice(0, lineEnd + 1) + block + text.slice(lineEnd + 1)
}

async function registerInArticles(slug, en, jp) {
  const href = `/${slug}`
  let text = await fs.readFile(ARTICLES_TS, "utf8")
  const m = en.meta || {}
  const jm = jp.meta || {}
  const title = m.title || en.h1 || slug
  const description = m.description || en.dek || ""
  const jpTitle = jm.title || jp.h1 || title
  const jpDescription = jm.description || jp.dek || description
  const category = (m.type || "").toLowerCase() === "review" ? "Review" : "Guide"
  const image = m.ogImage || en.leadImage?.src || ""
  const tags = Array.isArray(m.tags) ? m.tags : []
  const lastUpdated = (m.dateModified || m.datePublished || new Date().toISOString()).slice(0, 10)
  const j = (v) => JSON.stringify(v)

  const changes = []
  const hasLibHighlights = text.includes(`href: ${j(href)}`)
  if (!hasLibHighlights) {
    const libBlock =
`  {
    title: ${j(title)},
    description: ${j(description)},
    href: ${j(href)},
    category: ${j(category)},
    image: ${j(image)},
    tags: ${j(tags)},
    lastUpdated: ${j(lastUpdated)},
  },
`
    text = insertAfterAnchor(text, "// @publish-article:library", libBlock)
    text = insertAfterAnchor(text, "// @publish-article:highlights", libBlock)
    changes.push("ARTICLE_LIBRARY", "ARTICLE_HIGHLIGHTS")
  } else {
    log(`  • ${href} already in ARTICLE_LIBRARY/HIGHLIGHTS — skip`)
  }

  if (!text.includes(`${j(href)}: {`)) {
    const jpBlock =
`  ${j(href)}: {
    title: ${j(jpTitle)},
    description: ${j(jpDescription)},
  },
`
    text = insertAfterAnchor(text, "// @publish-article:jp", jpBlock)
    changes.push("ARTICLE_JP")
  } else {
    log(`  • ${href} already in ARTICLE_JP — skip`)
  }

  if (changes.length && !DRY) await fs.writeFile(ARTICLES_TS, text)
  if (changes.length) log(`  • registered in ${changes.join(", ")}${DRY ? " (dry)" : " ✓"}`)
  return changes.length > 0
}

// ---------- 3. restaurant + foodMapSlug (only if meta.restaurant present) ----------
// The article's full menu, in the restaurant `menu` shape (rendered on /food-map).
function articleMenu(en) {
  return (en.menuTable?.rows || [])
    .filter((row) => row.item)
    .map((row) => ({ item: row.item, ...(row.desc ? { desc: row.desc } : {}), ...(row.price ? { price: row.price } : {}) }))
}

async function ensureRestaurant(slug, en, jp) {
  const r = en.meta?.restaurant
  const href = `/${slug}`
  const ogImage = en.meta?.ogImage || en.leadImage?.src || ""
  const menu = articleMenu(en)
  const gallery = imagesFromArticle(en)
  const list = (await exists(CUSTOM_RESTAURANTS)) ? await readJson(CUSTOM_RESTAURANTS) : []
  const norm = (s) => String(s || "").toLowerCase().trim()

  // Sets the in-article Food Map CTA (meta.foodMapSlug) on both EN + JP.
  const setCta = (fmSlug) => { for (const doc of [en, jp]) { doc.meta = doc.meta || {}; doc.meta.foodMapSlug = fmSlug } }

  // Which restaurant should this article link to? Match an EXISTING one by slug
  // (meta.restaurant.slug or an author-set meta.foodMapSlug) or by exact name.
  const wantSlug = r?.slug || en.meta?.foodMapSlug
  const wantName = r?.name
  const existing = list.find((x) =>
    (wantSlug && (norm(x.slug) === norm(wantSlug) || norm(x.id) === norm(wantSlug))) ||
    (wantName && norm(x.name) === norm(wantName))
  )

  // 1) Restaurant already on the Food Map → connect the article to it
  //    (back-link + article photos + menu), don't create a duplicate.
  if (existing) {
    const fmSlug = existing.slug || existing.id || norm(existing.name).replace(/\s+/g, "-")
    const before = JSON.stringify(existing)
    existing.article_url = href
    if (ogImage) existing.article_image = ogImage
    const keep = keepFaceBasenames(en)
    // APPEND the article photos to the restaurant's existing photos — never
    // replace them. Existing photos come first so the gallery order is stable;
    // new article photos are added after, deduped by URL.
    const mergeGallery = (current) =>
      [...new Set([...(current || []), ...gallery])]
        .filter((src) => !keep.has(path.basename(src).toLowerCase()))
    existing.gallery = mergeGallery(existing.gallery)
    // The detail page renders `localGallery` whenever it's non-empty and only
    // falls back to `gallery` otherwise (see restaurant-detail-client.tsx). So
    // if this restaurant already has a localGallery, appending solely to
    // `gallery` would leave the new article photos invisible. Mirror the append
    // into localGallery too so the added photos always show.
    if (Array.isArray(existing.localGallery) && existing.localGallery.length) {
      existing.localGallery = mergeGallery(existing.localGallery)
    }
    if (menu.length && !(existing.menu && existing.menu.length)) existing.menu = menu
    const changed = JSON.stringify(existing) !== before
    if (changed && !DRY) await writeJson(CUSTOM_RESTAURANTS, list)
    setCta(fmSlug)
    log(`  • linked to existing restaurant /food-map/${fmSlug}${menu.length ? " (+menu)" : ""}${changed ? "" : " (already linked)"}${DRY ? " (dry)" : " ✓"}`)
    return changed
  }

  // 2) No match and no authoring block → can't create one.
  if (!r || !r.slug || !r.name) {
    log("  • no matching Food Map restaurant + no meta.restaurant block — skipping food-map link")
    return false
  }

  // 3) Create a new restaurant entry (incl. the article menu + CTA).
  const entry = {
    id: r.slug,
    name: r.name,
    slug: r.slug,
    address: r.address || "",
    description: r.description || r.editorial_summary || "",
    image: ogImage,
    location: { lat: r.lat ?? null, lng: r.lng ?? null },
    website: r.website || `https://nateeatshawaii.com${href}`,
    maps_url: r.maps_url || `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(`${r.name} ${r.address || ""}`)}`,
    opening_hours: r.opening_hours || "",
    price_level: r.price_level ?? 2,
    editorial_summary: r.editorial_summary || "",
    cuisine_types: r.cuisine_types || [],
    primary_type: r.primary_type || (r.cuisine_types || [])[0] || "Restaurant",
    neighborhood: r.neighborhood || "",
    special_features: r.special_features || [],
    // Don't auto-award the "Nate Recommends" badge — it must be set
    // deliberately (meta.restaurant.nate_recommended: true), never defaulted.
    nate_recommended: r.nate_recommended ?? false,
    featured: r.featured ?? true,
    price_range: r.price_range || undefined,
    article_url: href,
    article_image: ogImage,
    ...(menu.length ? { menu } : {}),
    editorial_summary_jp: r.editorial_summary_jp || jp.meta?.restaurant?.editorial_summary || "",
    description_jp: r.description_jp || jp.meta?.restaurant?.description || "",
    phone: r.phone || "",
    gallery,
    payment_methods: r.payment_methods || [],
    atmosphere: "",
    business_status: "OPERATIONAL",
    currently_open: true,
    is_open_now: true,
    open_status: "OPEN",
    created_at: new Date().toISOString(),
    source: "manual",
    article: "",
    last_google_sync_at: "",
    last_hours_updated_at: new Date().toISOString(),
    reservation_url: "",
    article_jp: "",
    permanentlyClosed: false,
    closedDate: "",
    closureReason: "",
    closureReason_jp: "",
  }
  list.unshift(entry)
  if (!DRY) await writeJson(CUSTOM_RESTAURANTS, list)
  setCta(r.slug)
  log(`  • created restaurant /food-map/${r.slug}${menu.length ? " (+menu)" : ""}${DRY ? " (dry)" : " ✓"}`)
  return true
}

// ---------- set meta flags on the translation files ----------
async function setMetaFlags(slug, en, jp) {
  let changed = false
  // ensureRestaurant set meta.foodMapSlug (create OR link); fall back to restaurant.slug.
  const foodMapSlug = en.meta?.foodMapSlug || en.meta?.restaurant?.slug
  for (const [p, doc] of [[enPath(slug), en], [jpPath(slug), jp]]) {
    doc.meta = doc.meta || {}
    let touched = false
    if (doc.meta.preWatermarked !== true) { doc.meta.preWatermarked = true; touched = true }
    if (foodMapSlug && doc.meta.foodMapSlug !== foodMapSlug) { doc.meta.foodMapSlug = foodMapSlug; touched = true }
    // never persist the restaurant authoring block into the shipped file
    if (doc.meta.restaurant) { delete doc.meta.restaurant; touched = true }
    if (touched) { if (!DRY) await writeJson(p, doc); changed = true }
  }
  if (changed) log(`  • set meta.preWatermarked${foodMapSlug ? " + meta.foodMapSlug" : ""}${DRY ? " (dry)" : " ✓"}`)
  return changed
}

// ---------- 0. validate the article JSON against the flat ArticleTemplate schema ----------
// Catches the "renders with no title" class of bug (article authored in the old
// nested shape) BEFORE it ships, plus a couple of SEO nits. Returns {errs, warns}.
function validateArticle(en) {
  const errs = [], warns = []
  if (!en.h1) {
    if (en.hero?.heading) errs.push("missing `h1` — found `hero.heading`. This is the OLD nested schema; ArticleTemplate needs flat h1/dek/byline (see any published article). Convert it, or the page renders with no title.")
    else errs.push("missing `h1`.")
  }
  if (Array.isArray(en.faq)) errs.push("`faq` is a bare array — template needs `faq.items[]` (a bare array also nulls the FAQ JSON-LD).")
  if (en.quickReference?.rows) errs.push("`quickReference.rows[]` is the wrong shape — template needs flat keys (location, priceRange, mustOrder, ...).")
  for (const s of en.sections || []) if (s.menuTable) errs.push(`section "${s.id}" nests a menuTable — move it to a top-level \`menuTable\`.`)
  const title = en.meta?.title || ""
  if (title.length > 60) warns.push(`meta.title is ${title.length} chars (>60) — Google truncates it; shorten the SEO title (the h1 can stay long).`)
  if (!en.meta?.ogImage) warns.push("meta.ogImage not set — will auto-pick a face-free cover if possible.")
  return { errs, warns }
}

// ---------- pick a face-free cover (meta.ogImage) ----------
// Runs AFTER images are blurred. If ogImage is unset or still contains a face,
// swap it for the first face-free article image (lead, then section images).
async function ensureCover(slug, en, jp) {
  if (faceDisabled) return false
  const candidates = []
  if (en.leadImage?.src) candidates.push(en.leadImage.src)
  for (const s of en.sections || []) for (const im of s.images || []) if (im.src) candidates.push(im.src)
  const uniq = []
  for (const s of [...new Set(candidates)]) if (await exists(publicFile(s))) uniq.push(s)
  if (!uniq.length) return false
  const probe = [...new Set([en.meta?.ogImage, ...uniq].filter(Boolean))]
  const detected = runFace(["detect", ...probe.map(publicFile)])
  if (!detected) return false // tooling unavailable → leave ogImage as-is
  const info = (src) => detected[publicFile(src)] || {}
  const hasFace = (src) => (info(src).faces || 0) > 0
  // Only OVERRIDE an already-set cover if it has a PROMINENT face (a real portrait,
  // e.g. a selfie) — never on a small false positive (a face-like blob in a food
  // shot). Otherwise a deliberately-chosen food cover would get swapped out.
  const hasProminentFace = (src) => hasFace(src) && (info(src).maxWidthFrac || 0) >= 0.12
  const current = en.meta?.ogImage
  if (current && !hasProminentFace(current)) return false // keep the chosen cover
  const pick = uniq.find((src) => !hasFace(src))
  if (!pick) { log("  ⚠ every candidate image has a face — leaving cover as-is"); return false }
  if (pick === current) return false
  for (const [p, doc] of [[enPath(slug), en], [jpPath(slug), jp]]) {
    doc.meta = doc.meta || {}
    doc.meta.ogImage = pick
    if (!DRY) await writeJson(p, doc)
  }
  log(`  • cover → face-free image ${path.basename(pick)}${current ? ` (was ${path.basename(current)})` : ""}${DRY ? " (dry)" : " ✓"}`)
  return true
}

// ---------- review star JSON-LD (only for type:"review" with a meta.rating) ----------
// Persists schemaExtra.review into the shipped EN+JP JSON so the page is eligible
// for ⭐ review rich-results. Must run BEFORE setMetaFlags strips meta.restaurant.
async function ensureReviewSchema(slug, en, jp) {
  const m = en.meta || {}
  if ((m.type || "").toLowerCase() !== "review") return false
  if (en.schemaExtra?.review) { log("  • review JSON-LD already present — skip"); return false }
  if (m.rating == null) { log('  • no meta.rating — skipping review JSON-LD (set e.g. "rating": 4.5 for ⭐ snippets)'); return false }
  const r = m.restaurant
  const foodSlug = m.foodMapSlug || r?.slug
  const itemReviewed = { "@type": "Restaurant", name: r?.name || en.h1 }
  if (r?.cuisine_types?.[0]) itemReviewed.servesCuisine = r.cuisine_types[0]
  if (r?.address) itemReviewed.address = r.address
  if (foodSlug) itemReviewed.url = `https://nateeatshawaii.com/food-map/${foodSlug}`
  const base = {
    "@context": "https://schema.org", "@type": "Review",
    itemReviewed,
    author: { "@type": "Person", name: "Nate", url: "https://nateeatshawaii.com/about" },
    publisher: { "@type": "Organization", name: "NateEatsHawaii" },
    datePublished: (m.datePublished || m.dateModified || "").slice(0, 10),
    reviewRating: { "@type": "Rating", ratingValue: String(m.rating), bestRating: "5", worstRating: "1" },
    reviewBody: m.reviewBody || en.dek || "",
  }
  en.schemaExtra = { ...(en.schemaExtra || {}), review: base }
  jp.schemaExtra = { ...(jp.schemaExtra || {}), review: { ...base, reviewBody: jp.meta?.reviewBody || jp.dek || base.reviewBody } }
  if (!DRY) { await writeJson(enPath(slug), en); await writeJson(jpPath(slug), jp) }
  log(`  • review JSON-LD added (rating ${m.rating})${DRY ? " (dry)" : " ✓"}`)
  return true
}

// ---------- detect candidates ----------
async function detectSlugs() {
  const dirs = (await fs.readdir(LOCALE_DIR, { withFileTypes: true })).filter((d) => d.isDirectory()).map((d) => d.name)
  const articlesText = await fs.readFile(ARTICLES_TS, "utf8")
  const out = []
  for (const slug of dirs) {
    const page = path.join(LOCALE_DIR, slug, "page.tsx")
    if (!(await exists(page))) continue
    const pageSrc = await fs.readFile(page, "utf8")
    if (!pageSrc.includes("ArticleTemplate")) continue          // only generic-template articles
    if (!(await exists(enPath(slug)))) continue
    if (!(await exists(jpPath(slug)))) continue
    if (articlesText.includes(`href: ${JSON.stringify(`/${slug}`)}`)) continue // already registered
    out.push(slug)
  }
  return out
}

async function publishOne(slug) {
  log(`\n▶ ${slug}${DRY ? "  [DRY RUN]" : ""}`)
  if (!(await exists(enPath(slug))) || !(await exists(jpPath(slug)))) {
    log(`  ✗ missing translations/en|jp/${slug}.json — skipping`)
    return
  }
  const en = await readJson(enPath(slug))
  const jp = await readJson(jpPath(slug))

  // 0. validate schema — hard-stop on a wrong-shape article so it never ships broken
  const { errs, warns } = validateArticle(en)
  for (const w of warns) log(`  ⚠ ${w}`)
  if (errs.length) {
    for (const e of errs) log(`  ✗ ${e}`)
    log(`  ✗ ${slug}: schema errors above — fix and re-run; not publishing this one.`)
    return
  }

  await processImages(slug, en)          // blur faces + watermark + optimize
  await ensureCover(slug, en, jp)        // pick a face-free meta.ogImage (before registration uses it)
  await registerInArticles(slug, en, jp)
  await ensureRestaurant(slug, en, jp)
  await ensureReviewSchema(slug, en, jp) // before setMetaFlags strips meta.restaurant
  await setMetaFlags(slug, en, jp)
}

;(async () => {
  let slugs = argSlugs
  if (!slugs.length) {
    slugs = await detectSlugs()
    if (!slugs.length) { log("No new (unregistered) ArticleTemplate articles found. Pass a slug to force, e.g. `npm run publish-article my-slug`."); return }
    log(`Detected ${slugs.length} new article(s): ${slugs.join(", ")}`)
  }
  for (const slug of slugs) await publishOne(slug)
  log(`\nDone${DRY ? " (dry run — nothing written)" : ""}. Now run: npm run build`)
})().catch((e) => { console.error(e); process.exit(1) })
