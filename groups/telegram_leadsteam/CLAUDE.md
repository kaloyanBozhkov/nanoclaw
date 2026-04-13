# Leads Team

## Purpose

Lead generation workspace. Given a business profile (**what** trade, **where**, **how many**), return **WhatsApp-reachable** businesses with their website and contact details. The team reaches out on WhatsApp, so the N the user asks for are specifically WhatsApp-reachable leads.

But: parsed contact info is valuable even without WhatsApp. So candidates that pass enrichment but fail the WhatsApp filter are **not dropped** — they're persisted to a secondary list (`no-whatsapp.csv`) for later use. Nothing that cost us a Jina turn to parse gets thrown away.

Two hard requirements for the **primary** output (`contacts.csv`):
1. **Website** — the business's own domain (not an aggregator listing). If you can't find the website, the candidate goes nowhere.
2. **WhatsApp** — a `wa.me/…`, `api.whatsapp.com/…`, `/whatsapp/` link, or an extractable "WhatsApp" link on the business's own site.

Candidates that have a website and phone/email but **no** WhatsApp signal → save to `no-whatsapp.csv`. Candidates that fail even the website check → don't persist.

Typical request shape: *"Find N {trade} in {city/region} that use WhatsApp."*

## Working directory

- Group folder: `/workspace/group/` — use `leads/` subfolder for persisted output
- **Search profile**: `/workspace/group/search-profile.json` (persistent — defines what we're hunting)
- **Primary list** (WhatsApp-reachable, what the team actions): `/workspace/group/leads/contacts.csv`
- **Secondary list** (enriched but no WhatsApp found — still valuable): `/workspace/group/leads/no-whatsapp.csv`
- Per-run exports: `/workspace/group/leads/{YYYY-MM-DD}-{slug}.csv`
- No repo mount. This group is workflow-only.

## Search profile (read on every session start)

Before responding to **any** message, read `/workspace/group/search-profile.json`. It defines the active hunt:

```json
{
  "business_type": "tattoo artist",
  "location": "Paris, France",
  "updated_at": "2026-04-13T12:00:00Z"
}
```

**If the file is missing or either field is empty**, your *first and only* action is to ask the user both questions in one message:

> What type of business are we looking for (e.g. *tattoo artist*), and what location (e.g. *Paris, France*)?

When they answer, write the JSON file and confirm with a one-line readback (`Locked in: {business_type} in {location}.`). Do not start searching until the profile exists.

**Updating the profile.** The user can change the profile at any time with natural language — examples:
- *"switch to dentists"* → update `business_type`
- *"now search Berlin"* → update `location`
- *"change to barbers in Lyon"* → update both
- *"show current profile"* → print the current values, don't modify

On any update, rewrite the file (bump `updated_at` to the current ISO timestamp) and confirm with the same one-line readback. Treat a profile change as a reset: the next lead request operates against the new profile, but **do not delete or rewrite `contacts.csv`** — old rows stay, new rows just carry the new trade/city.

When a lead request comes in, use `business_type` and `location` from the profile as the defaults — the user only needs to supply the count (and any extra filters) in their message.

## Tools

**Primary: `curl` + Jina Reader.** One HTTP call returns any page as clean markdown — no auth, no installation, no anti-bot fights. This is the default for both discovery and enrichment.

```bash
# Search (uses Jina's own search backend — no Google blocking)
Q="tattoo artist Paris France contact"
curl -sSL "https://s.jina.ai/$(printf %s "$Q" | jq -sRr @uri)"

# Fetch a specific page as markdown (handles JS rendering server-side)
curl -sSL "https://r.jina.ai/https://some-business.fr"
curl -sSL "https://r.jina.ai/https://some-business.fr/contact"
```

Country-specific directories are often higher signal than global search — wrap them in `r.jina.ai/` too:
- **France**: `https://www.pagesjaunes.fr/annuaire/chercherlespros?quoiqui={trade}&ou={city}`
- **UK**: `https://www.yell.com/ucs/UcsSearchAction.do?keywords={trade}&location={city}`
- **US/global**: `https://www.yelp.com/search?find_desc={trade}&find_loc={city}`
- **Google Maps (last resort via Jina)**: `https://www.google.com/maps/search/{trade}+{city}`

Parse in-response — markdown is dense with `tel:`, `mailto:`, `wa.me/…`, `api.whatsapp.com/send?phone=…` links. One `curl` + grep in the same reasoning turn = one LLM tool turn per site.

Jina's free tier is ~20 req/min without a key; stay under that or the calls start 429'ing. For >20 leads, pace the batch.

**Escalation: `agent-browser`** (full headless Playwright, loaded via the `agent-browser` skill — `agent-browser --help` to recall commands). Costs ~4× the tool turns of a `curl`. **Fall back to it only when**:
- Jina returns near-empty markdown (SPA with lazy-loaded contact info)
- You need to click/interact (cookie walls, "show phone number" buttons, contact forms)
- You need a screenshot to visually confirm a WhatsApp widget

Use it surgically, not by default.

## How to handle a lead request

**Budget before you start**: target **~3N + 5 tool turns total for N final leads** (over-fetch because most businesses won't have WhatsApp on their site). If you blow past 2× that, stop and report what you have — the approach is wrong and you should ask for guidance instead of burning more turns.

### Phase A — discovery (1–2 tool turns target)

1. **Load the profile.** Trade and location come from `search-profile.json` (see above). If the user specified a count in the message, use it; otherwise ask once for the count and wait. Don't start searching blind.
2. **Find candidates** via `s.jina.ai`:
   ```bash
   Q="{business_type} {location} whatsapp site contact"
   curl -sSL "https://s.jina.ai/$(printf %s "$Q" | jq -sRr @uri)"
   ```
   Including `whatsapp` in the query biases results toward sites that actually surface it. Scan the markdown for business names + **their own website URLs** (not aggregator listings). Collect **~5N candidates** — expect most to not have WhatsApp.
   - Drop any candidate without a discoverable own-domain website at this stage. An aggregator-only listing is not a lead.
   - If results look thin or dominated by aggregators, pivot to the country-specific directory (see Tools) wrapped in `r.jina.ai/`.
   - Only escalate to `agent-browser` on Google Maps if `s.jina.ai` **and** the country directory both fail.

### Phase B — enrichment + WhatsApp split (target 1 tool turn per candidate)

Every candidate that makes it to this phase gets fully parsed once — no re-fetching. Based on what the parse finds, the row is routed into one of two files.

3. For each candidate, fetch the homepage: `curl -sSL "https://r.jina.ai/<homepage>"`. In the **same** reasoning turn, extract everything you can:
   - **`name`** — business name from the page `<title>`, H1, or the search-result entry
   - **`website`** — the homepage URL you just fetched (mandatory; if there's no own-domain URL, drop the candidate — it shouldn't have gotten here)
   - **WhatsApp** signals:
     - `wa\.me/[0-9+]+`
     - `api\.whatsapp\.com/send\?phone=[0-9+]+`
     - any `/whatsapp/` path or `href="whatsapp:…"`
   - **Phone** — any `tel:` link or visible E.164 number
   - **Email** — `mailto:` links or visible addresses
   - **Address** — postal code + city pattern
4. **If no WhatsApp signal on the homepage and no phone either**, fetch **one** fallback page: `r.jina.ai/<homepage>/contact` (or `/contact-us`, `/about`). Re-run the same extraction. Do not walk more than 2 pages per candidate.
5. **Route the candidate**:
   - **Has WhatsApp** (extractable `wa.me` / `api.whatsapp.com` / `whatsapp:` link) → write to **`contacts.csv`**. Set `whatsapp_number` to the normalized E.164 from the link. If `phone_e164` is blank, copy `whatsapp_number` into it.
   - **No WhatsApp but has website + (phone OR email)** → write to **`no-whatsapp.csv`** (same schema, `whatsapp_number` blank). This is still valuable enriched data for later outreach via phone/email.
   - **No website, no phone, no email** → don't persist. Parse failed, nothing to save.
6. **Dedupe**. When writing to `contacts.csv`, dedupe on `whatsapp_number` first, then website domain, then `name+city`. When writing to `no-whatsapp.csv`, dedupe on website domain, then `phone_e164`, then `name+city`. Also check whether a candidate already exists in the *other* file — if a row is in `no-whatsapp.csv` and you just found WhatsApp for it, **move it** to `contacts.csv` (remove from the no-whatsapp file, insert into the primary file) and bump `last_checked`.
7. **Qualify.** Drop candidates that clearly don't match the trade or location (wrong industry, wrong city). Ambiguous ones go in the summary message under `needs_review`, not silently into either file.
8. **Stop when you've filtered N qualifying WhatsApp leads into `contacts.csv`** — don't keep enriching candidates just to pad `no-whatsapp.csv`. Under-delivering is fine: if you only found M<N WhatsApp-reachable businesses after burning the candidate pool, report `M found, N requested` and suggest broadening the location or trade.
9. **Deliver.** Append/update both files, write the per-run export under `/workspace/group/leads/{YYYY-MM-DD}-{slug}.csv` (**only the WhatsApp-reachable rows** — the per-run export mirrors `contacts.csv`), and send a short summary: how many new WhatsApp leads, how many went to no-whatsapp, how many were updated, and any gaps.

### When to escalate to `agent-browser`

Only if one of these is true for a specific site, and only for that site — don't switch modes for the whole batch:
- Jina returned near-empty markdown for both the homepage and the contact page
- The site has a "click to reveal phone" or cookie wall blocking the number
- You need visual confirmation of a WhatsApp chat widget that isn't in the DOM as a link

## Output format

Both files share the same schema:

```
name,trade,city,country,website,whatsapp_number,phone,phone_e164,email,address,source,confidence,last_checked,notes
```

- **`website`** — the business's own domain (homepage URL). **Mandatory in both files. Never blank.** If you don't have it, the row doesn't exist in either file.
- **`whatsapp_number`** — E.164 number extracted from the `wa.me/…` or `api.whatsapp.com/send?phone=…` link.
  - In **`contacts.csv`**: mandatory, never blank.
  - In **`no-whatsapp.csv`**: always blank (by definition).
- `phone` — as displayed on the site (human-readable), or blank
- `phone_e164` — normalized phone. In `contacts.csv` this may be a copy of `whatsapp_number` if the site only exposed WhatsApp; in `no-whatsapp.csv` it's the plain phone from the site.
- `confidence` — `high` / `medium` / `low`: how current/reachable you think the contact is
- `last_checked` — ISO date of the most recent visit
- `source` — URL of the **specific page** where you found the contact info (homepage, `/contact`, etc.) — not just the homepage
- `notes` — short free text, e.g. the text of the WhatsApp CTA (`"Chat on WhatsApp"`), or a caveat like `"only phone listed, no WhatsApp widget"`
- Leave optional cells blank rather than guessing. Never fabricate phone numbers, emails, or WhatsApp links.

**File roles**:
- `contacts.csv` — the team's action list. Every row is WhatsApp-reachable.
- `no-whatsapp.csv` — the "enriched but not WhatsApp-ready" reserve. Good data we've already paid tokens for; useful for later (different outreach channel, or re-check if we re-scrape and WhatsApp has since been added).
- Per-run export (`{YYYY-MM-DD}-{slug}.csv`) — mirrors what was added to `contacts.csv` in this run only.

If the user asks for a different format (markdown table, plain list, spreadsheet upload, etc.), follow their request — but still update both CSVs as the source of truth, and the WhatsApp split still applies.

## Rules

- **`contacts.csv` is WhatsApp-only; `no-whatsapp.csv` is the reserve for enriched-but-not-WhatsApp leads.** Never drop a candidate you've already parsed — route it to the right file. Only candidates that fail even the website+phone/email check get discarded.
- **`website` is mandatory on every row in both files.** `whatsapp_number` is mandatory in `contacts.csv` only. Don't pad either file with rows that have a blank website.
- **When you find WhatsApp for a candidate that's already in `no-whatsapp.csv`, move it** — remove from `no-whatsapp.csv`, insert into `contacts.csv`, bump `last_checked`. Don't leave stale duplicates across files.
- **Never fabricate contact data.** Blank > guessed. An inferred WhatsApp number (from a mobile-looking phone) is fabrication — it does not count.
- **A WhatsApp number is only valid when the markdown actually contains a `wa.me/…`, `api.whatsapp.com/…`, or `/whatsapp/` link.** An "WhatsApp" label without an extractable number is unverified — drop the lead.
- **Visit the real site.** Use `r.jina.ai/<homepage>` to fetch the business's own site. Don't copy contact details from directory aggregators if the business has its own domain — aggregators go stale and rarely expose WhatsApp links in their markdown anyway.
- **Default to `curl` + Jina. Escalate to `agent-browser` per-site, not per-batch.** If you're reaching for `agent-browser` on the first candidate, stop and rethink — you're about to blow the turn budget.
- **Under-deliver gracefully.** If the candidate pool is exhausted before reaching N, report `M found, N requested` and stop. Don't loop searching for more — ask the user to broaden the trade or location instead.
- **Respect robots.txt and ToS.** Don't scrape sources that forbid it. Prefer official listings, directories, and the businesses' own sites.
- **No cold-outreach drafting unless asked.** This group finds leads. Drafting messages is a separate ask.
- **Privacy:** only collect business contact info, not personal data about employees unless it's publicly listed as a business contact.
- **Cite sources** in the CSV (the specific page URL where you found the WhatsApp link, not just the homepage) so the team can verify.

## When the ask is ambiguous

Ask one targeted question, not a questionnaire. Common gaps (trade and location should already be in the profile — don't re-ask those):
- How many leads? (5? 50?)
- Anywhere within the location, or a specific district/radius?
- Any size filter (solo operator vs. established company)?
- Which fields are mandatory vs. nice-to-have?
