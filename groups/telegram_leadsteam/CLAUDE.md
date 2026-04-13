# Leads Team

## Purpose

Lead generation workspace. Given a business profile (**what** trade, **where**, **how many**), return contact details the team can reach out to.

Typical request shape: *"Find N {trade} in {city/region}. Include name, phone, email, website, address, and the best contact channel."*

## Working directory

- Group folder: `/workspace/group/` — use `leads/` subfolder for persisted output
- **Search profile**: `/workspace/group/search-profile.json` (persistent — defines what we're hunting)
- Master contact list: `/workspace/group/leads/contacts.csv` (append/update across sessions)
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

**Budget before you start**: target **~N+5 tool turns total for N leads**. If you blow past 3× that, stop and report what you have — the approach is wrong for that request and you should ask for guidance instead of burning more turns.

### Phase A — discovery (1–2 tool turns target)

1. **Load the profile.** Trade and location come from `search-profile.json` (see above). If the user specified a count in the message, use it; otherwise ask once for the count and wait. Don't start searching blind.
2. **Find candidates** via `s.jina.ai`:
   ```bash
   Q="{business_type} {location} contact website"
   curl -sSL "https://s.jina.ai/$(printf %s "$Q" | jq -sRr @uri)"
   ```
   Scan the markdown for business names + homepage URLs. Collect **2N candidates** so you can afford to drop bad matches in Phase B.
   - If results look thin or dominated by aggregators (Yelp/Tripadvisor/etc.), pivot to the country-specific directory (see Tools) wrapped in `r.jina.ai/`.
   - Only escalate to `agent-browser` on Google Maps if `s.jina.ai` **and** the country directory both fail.

### Phase B — enrichment (target 1 tool turn per lead)

3. For each candidate homepage, run **one** `curl -sSL "https://r.jina.ai/<homepage>"` and extract in the same reasoning turn:
   - **Phone** — match `tel:[+0-9 ().-]{7,}` or visible E.164-ish patterns
   - **WhatsApp** — match `wa\.me/[0-9+]+`, `api\.whatsapp\.com/send\?phone=[0-9+]+`, any `/whatsapp/` path, or the literal word "WhatsApp" adjacent to a phone number
   - **Email** — `mailto:` links or visible addresses
   - **Address** — postal code + city pattern
4. If the homepage has no phone, fetch **one** fallback page: `r.jina.ai/<homepage>/contact` (or `/contact-us`, `/about`). Do **not** walk more than 2 pages per site — if still empty, mark `confidence=low`, note "no contact info on site", and move on.
5. **Normalize phone numbers** to E.164 (`+<country><number>`, no spaces). If the country code isn't obvious from the business's location, leave `phone_e164` blank rather than guessing.
6. **Dedupe against `contacts.csv`** — match on `phone_e164` first, then website domain, then `name+city`. Update existing rows rather than creating duplicates; bump `last_checked` and fill in previously blank fields.
7. **Qualify.** Drop entries that clearly don't match the trade or location. Ambiguous ones go in the summary message under `needs_review`, not silently into the list.
8. **Deliver.** Append/update `contacts.csv`, write the per-run export under `/workspace/group/leads/{YYYY-MM-DD}-{slug}.csv`, and send a short summary: how many new, how many updated, how many had WhatsApp, and any gaps.

### When to escalate to `agent-browser`

Only if one of these is true for a specific site, and only for that site — don't switch modes for the whole batch:
- Jina returned near-empty markdown for both the homepage and the contact page
- The site has a "click to reveal phone" or cookie wall blocking the number
- You need visual confirmation of a WhatsApp chat widget that isn't in the DOM as a link

## Output format

Master file `contacts.csv` columns:

```
name,trade,city,country,phone,phone_e164,whatsapp,whatsapp_number,email,website,address,source,confidence,last_checked,notes
```

- `phone` — as displayed on the site (human-readable)
- `phone_e164` — normalized, or blank if unsure
- `whatsapp` — `yes` / `no` / `unknown` (did the site actually surface a WhatsApp link/button?)
- `whatsapp_number` — the number extracted from the `wa.me` / `api.whatsapp.com` link, E.164, or blank
- `confidence` — `high` / `medium` / `low`: how confident you are the contact is current and reachable
- `last_checked` — ISO date of the most recent visit
- `source` — URL of the page where you found the contact info (not just the homepage)
- Leave cells blank rather than guessing. Never fabricate phone numbers, emails, or WhatsApp links.

Per-run exports use the same schema, scoped to the rows touched in that run.

If the user asks for a different format (markdown table, plain list, spreadsheet upload, etc.), follow their request — but still update `contacts.csv` as the source of truth.

## Rules

- **Never fabricate contact data.** Blank > guessed. If you can't verify a field, leave it empty and say so.
- **A WhatsApp number is only `yes` if you actually saw a WhatsApp link/button on the site.** Don't infer it from a mobile-looking phone number.
- **Visit the real site.** Don't copy contact details from directory aggregators if the business has its own website — aggregators go stale.
- **Respect robots.txt and ToS.** Don't scrape sources that forbid it. Prefer official listings, directories, and the businesses' own sites.
- **No cold-outreach drafting unless asked.** This group finds leads. Drafting messages is a separate ask.
- **Privacy:** only collect business contact info, not personal data about employees unless it's publicly listed as a business contact.
- **Cite sources** in the CSV (the specific page URL, not just the homepage) so the team can verify.

## When the ask is ambiguous

Ask one targeted question, not a questionnaire. Common gaps (trade and location should already be in the profile — don't re-ask those):
- How many leads? (5? 50?)
- Anywhere within the location, or a specific district/radius?
- Any size filter (solo operator vs. established company)?
- Which fields are mandatory vs. nice-to-have?
