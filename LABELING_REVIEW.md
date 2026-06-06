# Pants Image Labeling — Review of Flagged Issues

**Scope:** 242 product photos across 6 folders (Cargo 10, Flat-front 23, Formal 43, Khaki 120, Linen 21, Relaxed 25), each labeled via filename `Type__Brand[_StyleCode]__Color__Size[_dupN]`. Also backs the `pants_products.xlsx` "Image map"/"Variants" sheets.

**Method:** Every image was opened and its tags/care-labels/handwriting read, then compared to the filename label. Findings below are flagged **for review — no labels have been changed.**

**Confidence is honest:** `High` = tag clearly contradicts the label; `Medium` = strong but not certain; `Low` = cannot confirm from the photo (re-check physically / re-shoot).

> **Important caveat — brand logos:** stylised brand logos on price tags are the least reliable field. The automated pass read the `Cargo__TexSlio` logo as "Tex Slio" and called it a match, yet you have confirmed the true brand is **Jery & Sluo**. Treat *every* brand that rests only on a logo (not printed text) as needing a human eyeball, even where not flagged below.

---

## 0. Your four known errors — status

| Image | Field | Was | Should be | Auto-review result |
|---|---|---|---|---|
| Cargo__TexSlio_R8B1-23__Tan__32 | Brand | Tex Slio | **Jery & Sluo** | MISSED — logo too stylised to read; included on your authority |
| FlatFront__HM_MuscleFit__Black__30 | Fit | Muscle Fit | **Skinny Fit** | ✅ Caught (High) |
| FlatFront__HM_RelaxedFit__Brown__34 | Fit | Relaxed Fit | **Slim Fit** | ✅ Caught (High) |
| FlatFront__HM_SkinnyFit__Black__32_2 | Size | 32 | **33** | ✅ Caught (High) |

---

## 1. High-confidence corrections (verify, then fix)

| Image file | Field | Current label | Image shows | Conf | Proposed action |
|---|---|---|---|---|---|
| Cargo__Generic_BC002__Gray__38 | Color | Gray | Clearly blue / slate-blue | High | Color → DarkBlue |
| Cargo__HD_1871-39__MintGreen__34 | Color | Mint Green | Tan / beige / khaki | High | Color → Tan |
| FlatFront__HM_SkinnyFit__Black__32 | Fit | Skinny Fit | Care label reads "SLIM FIT" | High | Fit → Slim Fit |
| Formal__Jingpinfushi__GrayBrown__23 | Size | 23 | Tag reads "52" | High | Size → 52 |
| Formal__Marcolorenzo_79796362__Stone__38 | Style | 79796362 | Tag reads "727965-62" | High | Style → 727965-62 |
| Khaki__BOSS_A3321__Beige__42 | Style | A3321 | Tag MODEL "A3332-1" | High | Style → A3332-1 |
| Khaki__Dobest_333821__MintGreen__36 | Style | 333821 | Tag "3388-21" (=338821) | High | Style → 338821 |
| Khaki__Dobest_338871__MintGreen__36 | Style | 338871 | Tag "3388-21" (=338821) | High | Style → 338821 (check vs the other 338821 — possible duplicate) |
| Khaki__Essential_281521__AlmondGreen__36 | Style | 281521 | Tag ART "7815-21" | High | Style → 781521 |
| Khaki__Essential_281521__AlmondGreen__40 | Style | 281521 | Tag ART "7815-21" | High | Style → 781521 |
| Khaki__Essential_781528__DarkBlue__34 | Style | 781528 | Tag ART "7815-26" | High | Style → 781526 |
| Khaki__FashionJeans_19988__DarkNavy__38 | Style | 19988 | Tag "1299-88" | High | Style → 1299-88 |
| Khaki__Generic_100325__Khaki__38 | Style+Brand | Generic / 100325 | "The Chinos", tag "1003-23" | High | Brand → The Chinos; Style → 1003-23 |
| Khaki__Generic_129088__DarkNavy__38 | Style+Brand | Generic / 129088 | "The Chinos", tag "1299-88" | High | Brand → The Chinos; Style → 1299-88 |
| Khaki__Generic_130321__Brown__36 | Style+Brand | Generic / 130321 | "The Chinos", tag "1303-21" | High | Brand → The Chinos; Style → 1303-21 |
| Khaki__Generic_130323__Cream__34 | Style+Brand | Generic / 130323 | "The Chinos", tag "1303-23" | High | Brand → The Chinos; Style → 1303-23 |
| Khaki__Generic_180328__CreamGray__38 | Style | 180328 | Tag "1303-28" (=130328) | High | Style → 130328 |
| Khaki__Generic_186812__Brown__36 | Style | 186812 | Tag "1303-12" (=130312) | High | Style → 130312 |
| Khaki__Realkingom_80216__Gray__34 | Style | 80216 | Tag/barcode "807-16" | High | Style → 80716 |
| Khaki__PoloMan_01817__OffWhite__36 | Style | 01817 | Tag "018-47" (identical tag to the 01847 file) | High | Style → 01847; confirm not a duplicate SKU |
| Khaki__GentryGrand_F7750__DarkGray__38 | Brand | Gentry Grand | Logo + tag read "GENTRY GLAD" | High | Brand → Gentry Glad |
| Khaki__GentryGlad_T34126__LightGray__36 | Style | T34126 | Tag "T331-26" (=T33126) | High | Style → T33126 |

---

## 2. Brand issues (misreads, hidden brands, spelling variants)

| Image file | Issue | Image shows | Conf | Proposed action |
|---|---|---|---|---|
| Cargo__TexSlio_R8B1-23__Tan__32 | Brand wrong | (your confirmation) | High | Brand → Jery & Sluo |
| Formal__Ferrando_VIAP11003__Navy__38 | Brand may be wrong | Waistband logo reads ~"DINYRO", not Ferrando | Medium | Verify brand |
| Khaki__Exho__ArmyGreen__38 | Truncated brand | "EXHO…" = Exhortation (crab logo) | Medium | Brand → Exhortation |
| Khaki__Kangom_80721__Navy__36 | Brand misread | Tag reads "Yangom" | Medium | Brand → Yangom (+ style 807-27) |
| Khaki__Lingom_40727 / _80727 (×3) | Brand misread | Tag reads "lengom (Paris)" | Medium | Brand → lengom; styles in "807-2x" form |
| Khaki__Generic__Gray__33 | Hidden brand | Embroidered "FUTURE" | Medium | Brand → Future |
| Khaki__Generic__Black__40 | Possible hidden brand | Crest/eagle patch, name illegible | Low | Inspect physically |
| Khaki__MassimoDutti_* | Knockoff look-alike | Tag "Massimo Dutti COLLECTION" | Low | **KEEP as printed** (per policy below) |

**Brand policy (decided):** use the **exact name printed on the tag**; correct only the *labeler's* transcription errors. Do **not** rename a knock-off toward the famous brand it imitates. Under this policy: `Barobrry`, `TommyHaifeige`, `BOSS`, `Mavi`, `MassimoDutti`, `Loio Piana` all **stay as printed**.

**Labeler transcription errors to correct (filename ≠ tag):**
- `RealKingdom` → **Realkingom** — every tag actually prints "realkingom".
- `Exho` → **Exhortation** (truncated in filename).
- `Kangom` → **Yangom**, `Lingom` → **lengom** (tags print these).
- `RossLehman` → **Rosslehman** (tag is one word).
- `Generic` → **The Chinos** / **Future** (brand visible on tag).

**Not changed:**
- `DiJieHao` vs `DiJiehao` — tags are all-caps; casing only, optional consistency tidy.
- `Marco` vs `Marcolorenzo` — keep each as its own tag prints; do **not** merge.
- `Loio Piana` (Relaxed) is **NOT** `Loro Piana` (Linen) — keep distinct.
- Note (informational only): `lengom` / `Yangom` / `realkingom` all tag as "PARIS" with `807-2x` codes — possibly one supplier, but kept as printed.

---

## 3. Colour discrepancies

> **Colour rule (decided):** where an image carries a **colour caption** (overlay / handwritten / printed colour word), the captioned colour **takes precedence** and no change is proposed — even over fabric appearance. The five images below marked **CAPTION — KEEP** were withdrawn for this reason (all captions matched the existing filename colour).

| Image file | Current | Image shows | Conf | Proposed action |
|---|---|---|---|---|
| Cargo__Generic_BC002__Gray__38 | Gray | Slate-blue, but overlay caption "gray" | — | **CAPTION — KEEP Gray** |
| Cargo__HD_1871-39__MintGreen__34 | Mint Green | Tan/khaki, but overlay caption "mint green" | — | **CAPTION — KEEP MintGreen** |
| Khaki__Architect_24RRP2708140__Cream__34 | Cream | Tag "Medium Khaki", but overlay caption "cream" | — | **CAPTION — KEEP Cream** |
| Khaki__LazerJeans_RK885510__GrayBaige__31 | GrayBaige | Solid beige, but overlay caption "gray baige" | — | **CAPTION — KEEP GrayBaige** |
| Khaki__HM__DarkBlue__30 | Dark Blue | Near-black, but overlay caption "dark blue" | — | **CAPTION — KEEP DarkBlue** |
| Formal__HamZara_HMZ1500738__DarkBrown__38 | Dark Brown | Navy/charcoal pinstripe (no caption) | Medium | Verify colour |
| Formal__HamZara_50650717__Grey__36 | Grey | Charcoal w/ pinstripe (no caption) | Low | Verify (pinstripe, not plain) |
| Formal__Marco_251492__DarkBrown__38 | Dark Brown | Grey/taupe sheen (no caption) | Low | Verify colour |
| Khaki__DiJieHao_PL230312__Tan__36 | Tan | Same beige as Cream sibling (no caption) | Low | Reconcile colour naming for style PL2303-12 |
| Near-black, no caption (group) | Black / DarkBrown / Navy | Dark fabric, can't split black vs navy/charcoal | Low | Verify under daylight: BigKingAllau Black ×2, Donlay DarkBrown, RossLehman Black ×2, Arc Black, Ferrando VIAP1657 Navy 36 |

---

## 4. Size issues

| Image file | Current | Image shows | Conf | Proposed action |
|---|---|---|---|---|
| FlatFront__HM_SkinnyFit__Black__32_2 | 32 | Care label US/EUR 33 | High | → 33 (your known error) |
| Formal__Jingpinfushi__GrayBrown__23 | 23 | Tag "52" | High | → 52 |
| Formal__Cobb__Stone__35 | 35 | Size grid appears to mark 36 | Medium | Verify → 36 |
| Formal__MassimoDutti_P69764613__Black__56 | 56 | Tag genuinely reads "56" | Medium | Tag agrees but implausible as waist-inches — confirm sizing system |
| Khaki__HM__LightGray__46 | 46 | Handwritten "46", no printed size | Low | Confirm (unusually large) |
| FlatFront__HM_SkinnyFit__Black__34 | 34 | Size line blurred (~39?) | Low | Re-shoot label to confirm |
| Several Cobb (Blue 34/36/42, Stone 32) | — | Size grid not legibly circled | Low | Confirm sizes from tag |

---

## 5. Fit issues (H&M flat-front & khaki)

| Image file | Current | Image shows | Conf | Proposed action |
|---|---|---|---|---|
| FlatFront__HM_MuscleFit__Black__30 | Muscle Fit | "SKINNY FIT" | High | → Skinny Fit |
| FlatFront__HM_RelaxedFit__Brown__34 | Relaxed Fit | "SLIM FIT" | High | → Slim Fit |
| FlatFront__HM_SkinnyFit__Black__32 | Skinny Fit | "SLIM FIT" | High | → Slim Fit |
| FlatFront__HM_SkinnyFit__Black__38_3 | Skinny Fit | "…COMFORT FIT" | Medium | Verify; likely not Skinny |
| FlatFront__HM_SlimFit__Grey__34 / 34_2 / 36 | Slim Fit | "SLIMMY COMFORT FIT" | Low | Confirm Slim vs Slim-Comfort variant |
| FlatFront__HM_SlimFit__BlueGreyPlaid__36 | Slim Fit | No fit word legible | Low | Confirm fit |
| FlatFront__HM__BlueBrownPlaid__33 | (no fit) | No care label photographed | Low | Re-shoot interior label to record fit |
| FlatFront__HM__Grey__33 | (no fit) | No care label photographed | Low | Re-shoot interior label to record fit |

---

## 6. Style-code issues that are FORMATTING ONLY (systemic — decide a convention)

The filenames consistently **drop the hyphen** the tags print (e.g. tag `PL2303-12` → filename `PL230312`, tag `1761-3` → `17613`). Where the digits agree this is harmless, but it (a) hides the genuine digit errors in §1 and (b) makes some codes ambiguous. Affected families: DiJieHao `PL2303-xx`, Dobest `3388-xx`, BOSS/Barobrry `A33x-x`, ClassicFashion `11502-99`, Essential `7815-xx`/`Z815-xx`, GentryGlad `2021-17`/`95-43`/`T331-26`, Timboored `1761-3`/`1772-3`, Mooherr `VIA-P2-x`, Ferrando `VIA-P1x-xx`, TommyHaifeige `A197-95`, Salameila `K88U2-2H`.

**Recommendation:** pick one canonical style-code format (keep hyphens **or** strip them consistently) and re-derive all codes from the tags.

Lower-confidence style reads to re-check: ParisBrand (`B816-15`, `B816-3`; `W615` clearly wrong → `B816-15`), HamZara (`HMZ50607-17`, `HMZ40402-?`, `HMZ1500738`?), LZ1978 `1301-37`, Architect `R`→`A` (`24ARP…`/`34ARP…`), MassimoDutti `A128-5R`/`MD2NO-5R`, Ferrando `VIAP110` vs `VIAP1015`/`VIAP11003`, Marco_251492 `25149-2`.

---

## 7. Missing data

- **Brand visible but labeled "Generic":** the four "The Chinos" items (§1), `Generic__Gray__33` = Future, possibly `Generic__Black__40`.
- **Style code on tag but absent from filename:** `Architect__DarkGray__34`, `ArnnieniJames__ArmyGreen__36`, `Formal__Marco__Stone__36` (tag 727905420), `Generic__DarkGray__34` (302711, "Slim").
- **Fit not captured:** the two `FlatFront__HM__` files (no care-label photo).

---

## 8. Possible duplicate SKUs to reconcile

- `PoloMan 01817` & `01847` — identical "018-47" tag.
- `Dobest 338871` & `338821` — both read "3388-21".
- `DiJieHao PL2303-12` appears as Cream/Tan/Khaki — one style, three colour names.
- `Essential 281521`(→781521) vs `781526` vs `Z81521` — confirm these are genuinely distinct articles.
- FlatFront `…Black__32` (Slim, see §1) vs `…Black__32_2` (Skinny, size 33) — the base/duplicate pairing is muddled; re-confirm which physical pair is which.

---

## 9. Colour-name normalization (whole dataset)

`Grey` vs `Gray` used interchangeably; also `GrayBaige` (typo), `CreamGray`, `SpaceGrey`, `DarkNavy` vs `NavyBlue` vs `Navy`, `AlmondGreen` vs `MintGreen`. Standardize the palette before import (the Variants-sheet SKUs are built from colour, so spelling drift creates split SKUs).

---

*No files renamed and no spreadsheet cells edited. Awaiting your decision on which corrections to apply.*
