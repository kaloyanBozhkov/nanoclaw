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
- **Review queue** (WhatsApp widget suspected, or ambiguous trade/location match — needs human eye or `agent-browser` verification): `/workspace/group/leads/review.csv`
- **Pending queue** (discovered but not yet enriched — resume cursor): `/workspace/group/leads/pending.csv`
- **Country directories cache** (directory URLs learned on first encounter): `/workspace/group/directories.json`
- Per-run exports: `/workspace/group/leads/{YYYY-MM-DD}-{slug}.csv`
- No repo mount. This group is workflow-only.

**The four CSVs together form the bot's memory of what's already been touched.** Any candidate whose normalized website domain appears in *any* of them has already been seen — don't re-enrich it (subject to the staleness rule in Phase A).

## Search profile (read on every session start)

Before responding to **any** message, read `/workspace/group/search-profile.json`. It defines the active hunt:

```json
{
  "business_type": "tattoo artist",
  "location": "Paris, France",
  "exclude": ["Hoche Tattoo", "O'Kult"],
  "min_rating": 4.0,
  "size": "solo",
  "language": "fr",
  "updated_at": "2026-04-13T12:00:00Z"
}
```

**Required fields**: `business_type`, `location`. The rest are optional filters:

- **`exclude`** — array of brand/chain names (case-insensitive substring match on the business name) to skip. Use for chains the team has already tried or doesn't want.
- **`min_rating`** — minimum Google/Yelp/directory rating on a 0–5 scale. Drop candidates below this.
- **`size`** — `solo` | `small` | `any` | `chain_ok`. Defaults to `any`. Heuristic: `solo` = one practitioner/single location, `small` = 2–10 staff, `chain_ok` = include chains.
- **`language`** — ISO code (`fr`, `en`, `es`, etc.). Used to bias the discovery query wording and filter out non-matching sites if obvious from the markdown.

**If the required fields are missing or empty**, your *first and only* action is to ask the user both questions in one message:

> What type of business are we looking for (e.g. *tattoo artist*), and what location (e.g. *Paris, France*)?

When they answer, write the JSON file (just the required fields — optional ones stay absent) and confirm with a one-line readback (`Locked in: {business_type} in {location}.`). Do not start searching until the profile exists.

**Updating the profile.** The user can change any field at any time with natural language — examples:
- *"switch to dentists"* → update `business_type`
- *"now search Berlin"* → update `location`
- *"change to barbers in Lyon"* → update both
- *"only rating 4.5 and above"* → set `min_rating: 4.5`
- *"skip chains"* → set `size: "solo"`
- *"exclude Hoche and O'Kult"* → append to `exclude`
- *"clear excludes"* → remove the `exclude` field
- *"show current profile"* → print the current values, don't modify

On any update, rewrite the file (bump `updated_at` to the current ISO timestamp) and confirm with the same one-line readback — if a non-trivial filter like `exclude` or `min_rating` changed, include it in the readback so the user can catch mistakes (`Locked in: tattoo artist in Paris, France — rating ≥4.0, excluding [Hoche, O'Kult].`). Treat a profile change as a reset for future runs — but **do not delete or rewrite `contacts.csv` / `no-whatsapp.csv` / `review.csv`**. Old rows stay; new rows carry the new trade/city. `pending.csv` rows that don't match the new profile remain dormant — mention in the profile-change confirmation how many pending rows are now "dormant" so the user knows they're still around.

When a lead request comes in, use the profile as the default — the user only needs to supply the count (and any override filters) in their message.

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

### Rate-limit handling (important)

Jina's free tier is ~20 req/min without a key. Above that it 429s hard. For any run that'll touch more than ~15 sites, pace yourself:

- **Sleep 3 seconds between `r.jina.ai` fetches** in the enrichment loop: `sleep 3` at the top of each iteration. At ~3s/req you stay comfortably under 20/min.
- **Detect 429 explicitly**: `curl -w "%{http_code}" -o /tmp/jina.md …` and check. If it's 429 or empty, `sleep 30` and retry once. If the retry also 429s, the run is too large for free-tier — stop enrichment, save the rest to `pending.csv`, and report "hit Jina rate limit at M of N, queued the rest for next run."
- **A 429 response is not a parse failure** — do not route the candidate to `no-whatsapp.csv`. Put it back in `pending.csv` and keep going with the next candidate.
- **If a `JINA_API_KEY` env var is set**, add `-H "Authorization: Bearer $JINA_API_KEY"` to every call. Keys bump the limit from 20→200 req/min and are the right answer for runs >20 leads. Ask the user if they want to set one if you hit the rate ceiling twice.

### Domain normalization

Dedup across files uses **normalized domains**, not raw URLs. Before comparing any website URL against `seen_domains`, normalize it:

```bash
# Normalize: lowercase, strip scheme, strip www., drop path/query, drop trailing dot
normalize_domain() {
  printf %s "$1" \
    | sed -E 's#^https?://##; s#^www\.##; s#/.*$##; s#\?.*$##; s#\.$##' \
    | tr '[:upper:]' '[:lower:]'
}
```

`https://www.Example.com/fr/contact?ref=1` → `example.com`. Use this on every URL before it touches the `seen_domains` set, `pending.csv` dedup, or the `website` column. Two candidates are duplicates iff their normalized domains are equal.

### WhatsApp widget vendor signatures

Many small businesses use a JS-injected WhatsApp chat widget instead of a `wa.me` link. Those widgets are invisible in `r.jina.ai`'s static markdown — we'll think the site has no WhatsApp when it actually does. Mitigate by grepping the markdown for **vendor fingerprints**:

```
tidio           wati.io          gorgias         tawk.to
chaport         intercom.io      whatsapp-chat   wa-chat
floating-whatsapp   wp-whatsapp  wati-webchat    getbutton.io
crisp.chat      drift            chatway         whatsapp-button
web.whatsapp.com (iframe src)
```

If **none** of the structured WhatsApp signals are present (`wa.me`, `api.whatsapp.com`, `/whatsapp/`, `href="whatsapp:…"`) **but one of these vendor fingerprints is**, mark the candidate as `widget_suspected=true` and route it to `review.csv` instead of `no-whatsapp.csv`. The user (or a later `agent-browser` pass) can verify with a screenshot.

### Country-specific directories

Higher signal than global search — wrap them in `r.jina.ai/` too. Known list (persist new ones to `/workspace/group/directories.json` on first encounter):

- **France** (`fr`): `https://www.pagesjaunes.fr/annuaire/chercherlespros?quoiqui={trade}&ou={city}`
- **UK** (`gb`): `https://www.yell.com/ucs/UcsSearchAction.do?keywords={trade}&location={city}`
- **US/global** (`us`): `https://www.yelp.com/search?find_desc={trade}&find_loc={city}`
- **Germany** (`de`): `https://www.gelbeseiten.de/Suche/{trade}/{city}`
- **Italy** (`it`): `https://www.paginegialle.it/ricerca/{trade}/{city}`
- **Spain** (`es`): `https://www.paginasamarillas.es/search/{trade}/all-ma/all-pr/all-is/all-ci/{city}/all-ba/all-pu/all-nc/1`
- **Google Maps (last resort via Jina)**: `https://www.google.com/maps/search/{trade}+{city}`

If the profile points to a country not in this list, **find a local directory once, then cache it**: use `s.jina.ai` with a query like `"yellow pages site list {country}"` or `"best business directory {country}"`, pick the most authoritative-looking one, test it with a small search, and write the template to `directories.json`:

```json
{
  "pl": {"name": "Panorama Firm", "template": "https://panoramafirm.pl/szukaj?k={trade}&l={city}"},
  "br": {"name": "TeleListas", "template": "https://www.telelistas.net/pesquisa/{trade}/{city}"}
}
```

Next time a Polish or Brazilian profile lands, read from `directories.json` instead of re-discovering.

Parse in-response — markdown is dense with `tel:`, `mailto:`, `wa.me/…`, `api.whatsapp.com/send?phone=…` links. One `curl` + grep in the same reasoning turn = one LLM tool turn per site.

**Escalation: `agent-browser`** (full headless Playwright, loaded via the `agent-browser` skill — `agent-browser --help` to recall commands). Costs ~4× the tool turns of a `curl`. **Fall back to it only when**:
- Jina returns near-empty markdown (SPA with lazy-loaded contact info)
- You need to click/interact (cookie walls, "show phone number" buttons, contact forms)
- You need a screenshot to visually verify a widget-suspected candidate from `review.csv`

Use it surgically, not by default.

## How to handle a lead request

**Budget before you start**: target **~3N + 5 tool turns total for N final leads** (over-fetch because most businesses won't have WhatsApp on their site). If you blow past 2× that, stop and report what you have — the approach is wrong and you should ask for guidance instead of burning more turns.

### Step 0 — acknowledge before you start working

Lead runs take minutes, and the team needs to know you heard them and are working. **Before any tool call that fetches data**, call the `send_message` MCP tool with a one- or two-line summary of what you're about to do. Example:

> *On it — finding 20 tattoo artists in Paris, France with WhatsApp. I'll split the results into `contacts.csv` (WhatsApp-reachable) and `no-whatsapp.csv` (website+phone only). Back in a few minutes.*

Rules for this confirmation message:
- **Call `send_message` first, before any `curl` / `agent-browser` / profile update.** Reading the CSVs first (Phase A step 2–3) is fine — those are local file reads, not tool turns the user cares about. But the ack must go out before any network fetch.
- **Restate the concrete parameters**: the trade, the location, the count, and anything special the user asked for. This is how the user catches misinterpretations before you burn 30 tool calls on the wrong query.
- **Mention the resume state**: if `pending.csv` had K matching rows for the current profile, say something like *"Resuming from K queued candidates before fresh search."* If `contacts.csv` + `no-whatsapp.csv` already have K known domains we'll skip, mention that too. This tells the user the bot has memory.
- **Set expectations**: mention roughly how long ("a few minutes"), that you'll report progress if something changes (e.g. can't find N), and that all three files get updated.
- **Don't ack trivial replies.** Profile updates (`"switch to dentists"`), `"show current profile"`, and one-liner questions don't need a work-ack — they're fast enough to answer directly. This acknowledgement is specifically for lead-generation runs.
- **Don't ack twice.** If you ack and then discover you need to ask a clarifying question, ask it — but don't send another ack before resuming.

The final lead-run summary at the end of the job is separate from this ack — you still send that after the work is done.

### Phase A — load memory, then discover (1–2 tool turns target)

1. **Load the profile.** Trade and location come from `search-profile.json` (see above). If the user specified a count in the message, use it; otherwise ask once for the count and wait. Don't start searching blind.

2. **Load the bot's memory.** Read all four CSVs from `/workspace/group/leads/`:
   - `contacts.csv`
   - `no-whatsapp.csv`
   - `review.csv`
   - `pending.csv`

   Build a **`seen_domains`** set of **normalized domains** (see "Domain normalization" in Tools — strip scheme, `www.`, path, lowercase). Apply the **staleness rule** as you build it:
   - Rows in **`contacts.csv`** → always in `seen_domains` (we already have WhatsApp, no reason to re-fetch).
   - Rows in **`no-whatsapp.csv`** → in `seen_domains` **only if `last_checked` is within the last 60 days**. Older rows fall out and become eligible for re-enrichment — they're our best candidates for "has this business added WhatsApp since we last checked?". When you re-enrich a stale `no-whatsapp.csv` row, **remove the old row** before writing the new one (it'll be re-added in Phase B routing).
   - Rows in **`review.csv`** → in `seen_domains` always (they're already flagged for human attention; no point re-fetching until someone acts on them).
   - Rows in **`pending.csv`** → in `seen_domains` always (we'll drain them in step 3 anyway).

   If any file doesn't exist yet, treat it as empty — create it on first write with the header row.

3. **Drain the pending queue first** (resume where the last run stopped):
   - Filter `pending.csv` rows to ones matching the current profile (`trade == business_type` *and* `city == location`'s city component, case-insensitive; respect `exclude` and `min_rating` if set).
   - These are your **first enrichment candidates** in Phase B. They were discovered previously but never enriched — reusing them costs zero discovery turns.
   - Rows that don't match the current profile stay in `pending.csv` untouched — they'll be picked up again when the profile swings back.
   - Rows marked for re-enrichment from the staleness rule (expired `no-whatsapp.csv` entries) join the queue at the end, after fresh pending and before fresh discovery.

4. **If pending + stale-refreshes are empty or exhausted**, find fresh candidates via `s.jina.ai`:
   ```bash
   Q="{business_type} {location} whatsapp site contact"
   curl -sSL "https://s.jina.ai/$(printf %s "$Q" | jq -sRr @uri)"
   ```
   Including `whatsapp` in the query biases results toward sites that actually surface it. Scan the markdown for business names + **their own website URLs** (not aggregator listings). Collect **~5N candidates** — expect most to not have WhatsApp.
   - **Normalize every candidate domain first**, then filter out any whose normalized domain is in `seen_domains`. Already-touched domains never get re-enriched (except via the staleness rule above).
   - **Apply profile filters during scanning**: drop names that match `exclude`; skip anything with a visible rating below `min_rating`; respect `size` if the listing gives you a staff/location count.
   - Drop any candidate without a discoverable own-domain website at this stage. An aggregator-only listing is not a lead.
   - If results look thin or dominated by aggregators, pivot to the country-specific directory. Look up the directory URL for the profile's country in `/workspace/group/directories.json` (or the known list in Tools). **If no directory is known for this country, find one and cache it to `directories.json` before proceeding** — see Tools section for the pattern. Apply the same `seen_domains` + profile filter to its results.
   - Only escalate to `agent-browser` on Google Maps if `s.jina.ai` **and** the country directory both fail.

### Phase B — enrichment + WhatsApp split (target 1 tool turn per candidate)

Every candidate that makes it to this phase gets fully parsed once — no re-fetching. Based on what the parse finds, the row is routed into one of four files.

Your enrichment queue is: **drained pending candidates → stale-refresh candidates → fresh discovery candidates**, in that order. Process them until you've filtered N qualifying WhatsApp leads into `contacts.csv` or the queue is empty.

5. For each candidate, **`sleep 3`** (Jina rate-limit pacing), then fetch the homepage: `curl -sSL "https://r.jina.ai/<homepage>"`. Handle 429 per the rate-limit section in Tools. In the **same** reasoning turn, extract everything you can:
   - **`name`** — business name from the page `<title>`, H1, or the search-result entry
   - **`website`** — the normalized domain of the homepage URL you just fetched (mandatory)
   - **WhatsApp structured signals**:
     - `wa\.me/[0-9+]+`
     - `api\.whatsapp\.com/send\?phone=[0-9+]+`
     - any `/whatsapp/` path or `href="whatsapp:…"`
   - **WhatsApp widget fingerprints** (see Tools vendor list — `tidio`, `wati`, `gorgias`, etc.). Record a boolean `widget_suspected`.
   - **Phone** — any `tel:` link or visible E.164 number
   - **Email** — `mailto:` links or visible addresses
   - **Address** — postal code + city pattern
   - **Rating** (if visible on the page, e.g. schema.org markup) — for profile filtering
6. **If no WhatsApp signal on the homepage and no phone either**, fetch **one** fallback page: `r.jina.ai/<homepage>/contact` (or `/contact-us`, `/about`). Re-run the same extraction. Do not walk more than 2 pages per candidate.
7. **Progress ping.** Every 5 candidates processed, call `send_message` with a one-liner: *"7/20 — 3 with WhatsApp, 2 in review, 1 sent to no-whatsapp, 1 parse failed."* Don't ping on every candidate (noisy) and don't ping only at the end (silent). Every 5 is the sweet spot. Skip progress pings for runs where N ≤ 5 — just deliver the final summary.
8. **Qualify.** Apply the profile filters to what you parsed:
   - Business name matches `exclude`? → drop, not persisted.
   - Visible rating below `min_rating`? → drop, not persisted.
   - Clearly wrong trade (e.g. searching "tattoo artist" but the site is a piercing-only studio)? → route to `review.csv` with `notes="trade mismatch: {details}"` for human confirmation.
   - Clearly wrong location (right trade, wrong city)? → drop silently.
9. **Route the candidate**:
   - **Has structured WhatsApp signal** → write to **`contacts.csv`**. Set `whatsapp_number` to the normalized E.164 from the link. If `phone_e164` is blank, copy `whatsapp_number` into it.
   - **No structured WhatsApp but `widget_suspected=true`** → write to **`review.csv`** with `notes="widget suspected: {vendor}"`. A later `agent-browser` pass can confirm with a screenshot — do **not** escalate now unless the user explicitly asks.
   - **Trade match is ambiguous** (couldn't confidently confirm the business matches the profile's trade) → write to **`review.csv`** with `notes="trade ambiguous: {details}"`.
   - **No WhatsApp signal, no widget suspicion, has website + (phone OR email)** → write to **`no-whatsapp.csv`** (same schema, `whatsapp_number` blank). Still valuable enriched data for later outreach via phone/email.
   - **No website, no phone, no email** → don't persist. Parse failed, nothing to save.
   - **Whichever file it lands in (or none), if this candidate came from `pending.csv`, remove its row from `pending.csv`** — it's been processed, it shouldn't get re-drained next run.
10. **Dedupe** (all comparisons use **normalized domains**). When writing to `contacts.csv`, dedupe on `whatsapp_number` (digits-only, stripped of `+` and spaces) first, then normalized website domain, then `name+city`. When writing to `no-whatsapp.csv` or `review.csv`, dedupe on normalized website domain, then phone digits, then `name+city`. **Cross-file moves**:
    - Found WhatsApp for a row already in `no-whatsapp.csv` → move to `contacts.csv`, bump `last_checked`.
    - Found WhatsApp for a row already in `review.csv` (widget confirmed / trade cleared) → move to `contacts.csv`.
    - A stale `no-whatsapp.csv` row re-enriched still has no WhatsApp → overwrite the old row in place (new `last_checked`).
11. **Stop when you've filtered N qualifying WhatsApp leads into `contacts.csv`.** Don't keep enriching just to pad `no-whatsapp.csv` or `review.csv`. Under-delivering is fine: if you only found M<N WhatsApp-reachable businesses after burning the candidate pool, report `M found, N requested` and suggest broadening the location, trade, or min_rating.
12. **Save the cursor** — write any *unprocessed* candidates (still in your in-memory queue) to **`pending.csv`**, with the current profile's `trade`, `city`, `country`, normalized `website`, `source` (the discovery URL they came from), and `last_checked` = today. These are the resume cursor for next run. Dedupe by normalized website domain against `pending.csv` itself.
13. **Deliver.** Append/update all files, write the per-run export under `/workspace/group/leads/{YYYY-MM-DD}-{slug}.csv` (**only the WhatsApp-reachable rows** — the per-run export mirrors `contacts.csv`), and send a short summary via `send_message`: how many new WhatsApp leads, how many went to `no-whatsapp`, how many went to `review` (and why), how many came from the pending queue vs. stale refresh vs. fresh discovery, how many remain in `pending.csv` for next time, and any gaps. If `review.csv` has rows, mention the count explicitly and tell the user they can say *"verify widgets"* or *"show review queue"* to action them.

### When to escalate to `agent-browser`

Only if one of these is true for a specific site, and only for that site — don't switch modes for the whole batch:
- Jina returned near-empty markdown for both the homepage and the contact page
- The site has a "click to reveal phone" or cookie wall blocking the number
- You need visual confirmation of a WhatsApp chat widget that isn't in the DOM as a link

## Output format

All four CSVs share the same schema:

```
name,trade,city,country,website,whatsapp_number,phone,phone_e164,email,address,rating,source,confidence,widget_suspected,last_checked,notes
```

- **`website`** — the business's own normalized domain (no scheme, no `www.`, no path). **Mandatory in `contacts.csv`, `no-whatsapp.csv`, and `review.csv`. Also mandatory in `pending.csv`.** Never blank.
- **`whatsapp_number`** — E.164 number extracted from the `wa.me/…` or `api.whatsapp.com/send?phone=…` link.
  - In **`contacts.csv`**: mandatory, never blank.
  - In **`no-whatsapp.csv`** / **`review.csv`** / **`pending.csv`**: always blank.
- `phone` — as displayed on the site (human-readable), or blank
- `phone_e164` — best-effort normalized phone. If you can't determine the country code, store the digits as they appear with only whitespace/punctuation stripped. Dedup uses the digit-only form, not E.164 specifically — don't agonize over formatting.
- `rating` — 0–5 numeric rating parsed from the site or directory listing, or blank
- `widget_suspected` — `true` / `false`. `true` only in `review.csv` rows that had a widget vendor fingerprint but no structured WhatsApp link. `false` everywhere else.
- `confidence` — `high` / `medium` / `low`: how current/reachable you think the contact is
- `last_checked` — ISO date of the most recent visit. Used by the Phase A staleness rule (60-day gate for `no-whatsapp.csv`).
- `source` — URL of the **specific page** where you found the contact info (homepage, `/contact`, etc.) — not just the homepage
- `notes` — short free text, e.g. `"Chat on WhatsApp"`, `"widget suspected: tidio"`, `"trade ambiguous: listed as 'body art studio'"`, or `"only phone listed, no WhatsApp widget"`
- Leave optional cells blank rather than guessing. Never fabricate phone numbers, emails, or WhatsApp links.

**File roles**:
- **`contacts.csv`** — the team's action list. Every row is WhatsApp-reachable.
- **`no-whatsapp.csv`** — the "enriched but not WhatsApp-ready" reserve. Good data we've already paid tokens for; useful for later (different outreach channel, or re-check when the 60-day staleness gate expires).
- **`review.csv`** — the human-in-the-loop queue. Two kinds of rows land here:
  1. `widget_suspected=true` — the parse found a widget vendor fingerprint but no extractable WhatsApp number. Needs an `agent-browser` screenshot to confirm.
  2. Ambiguous trade match — the business might or might not be the right trade; a human needs to glance. `widget_suspected=false` for these.
  Rows in `review.csv` are **never** re-enriched automatically — they stay until the user acts on them (`verify widgets`, `confirm {row}`, `discard {row}`, etc.).
- **`pending.csv`** — the **resume cursor**. Candidates discovered in Phase A but not yet enriched. Only `name`, `website`, `trade`, `city`, `country`, `source`, `last_checked` are populated. A row disappears the moment it's enriched and routed.
- **Per-run export** (`{YYYY-MM-DD}-{slug}.csv`) — mirrors what was added to `contacts.csv` in this run only. Not `review` or `no-whatsapp` rows.

**Supporting memory files**:
- **`/workspace/group/search-profile.json`** — active hunt definition (see Search profile section).
- **`/workspace/group/directories.json`** — country → directory URL template cache. Learned on first encounter, reused afterward.

If the user asks for a different format (markdown table, plain list, spreadsheet upload, etc.), follow their request — but still update all CSVs as the source of truth.

## User commands & affordances

Short natural-language asks the user may send outside a lead-generation run:

- **`show me the latest contacts`** / **`show me the last N leads`** — read `contacts.csv`, sort by `last_checked` descending, and send the top N (default 20) as a **markdown table** via `send_message`. Columns: `name`, `website`, `whatsapp_number`, `phone`, `city`. No tool calls needed for this — it's a local file read + format.
- **`export contacts.csv`** / **`send me the file`** — same as above for now (there's no file attachment tool in the container). Tell the user the file lives at `/workspace/group/leads/contacts.csv` on the host if they want the raw file; otherwise dump as markdown.
- **`show review queue`** — dump `review.csv` rows as a markdown table with `name`, `website`, `notes`, `widget_suspected`.
- **`verify widgets`** — take all `review.csv` rows where `widget_suspected=true`, run `agent-browser` on each homepage, take a screenshot, and report (one message per row, or a consolidated summary). Confirmed WhatsApp → move row to `contacts.csv`. Confirmed no-WhatsApp → move to `no-whatsapp.csv`. This is the **only** time `agent-browser` runs in batch mode.
- **`confirm {domain}`** / **`discard {domain}`** — manually resolve a single `review.csv` row. `confirm` treats the business as WhatsApp-reachable and moves it to `contacts.csv` (requires a `whatsapp_number` — ask if missing); `discard` moves it to `no-whatsapp.csv`.
- **`clear pending`** — wipe `pending.csv` for the current profile (or all rows if the user says "all"). Confirm the count first.
- **`stats`** — report file sizes: how many rows in each of contacts/no-whatsapp/review/pending, plus how many of each match the current profile.
- **`show current profile`** — print the profile JSON.

## Rules

- **Four files, four purposes.** `contacts.csv` = WhatsApp-only (team's action list). `no-whatsapp.csv` = enriched reserve. `review.csv` = human-in-the-loop (widget suspects and ambiguous trade matches). `pending.csv` = resume cursor. Never drop a candidate you've already parsed — route it.
- **`website` is mandatory on every row in every file.** `whatsapp_number` is mandatory in `contacts.csv` only. Don't pad any file with rows that have a blank website.
- **Dedup uses normalized domains, not raw URLs.** Always run candidate URLs through the normalization helper (strip scheme, `www.`, path, lowercase) before comparing. `https://www.Example.com/fr/` and `https://example.com` are the same lead.
- **Phone dedup uses digit-only strings, not strict E.164.** Strip `+`, spaces, dashes, parens. Compare the digits. E.164 is a best-effort display format, not a dedup key.
- **Staleness gate**: `no-whatsapp.csv` rows fall out of `seen_domains` after 60 days and become eligible for re-enrichment. `contacts.csv` / `review.csv` / `pending.csv` are always in `seen_domains` regardless of age.
- **Never re-enrich a known domain** (subject to the staleness rule). The four files together are the bot's memory.
- **`pending.csv` rows are cursors, not outputs.** A row disappears the moment it's enriched and routed.
- **`review.csv` rows are frozen until the user acts on them.** Don't auto-verify widget suspects — wait for `verify widgets` or similar.
- **Never fabricate contact data.** Blank > guessed. An inferred WhatsApp number (from a mobile-looking phone) is fabrication — it does not count.
- **A WhatsApp number is only valid in `contacts.csv` when the markdown actually contains a `wa.me/…`, `api.whatsapp.com/…`, or `/whatsapp/` link.** A widget fingerprint alone routes to `review.csv`, not `contacts.csv`.
- **Respect the Jina rate limit.** `sleep 3` between `r.jina.ai` calls. Detect 429, back off, and put unfetched candidates into `pending.csv` if the limit keeps hitting — don't route them to `no-whatsapp.csv` as if they failed.
- **Send progress pings every 5 candidates in runs where N > 5.** Users staring at a silent chat assume the bot is stuck.
- **Visit the real site.** Use `r.jina.ai/<homepage>` to fetch the business's own site. Don't copy contact details from directory aggregators if the business has its own domain.
- **Default to `curl` + Jina. Escalate to `agent-browser` per-site, not per-batch** — except for the explicit `verify widgets` command, which is a supervised batch mode.
- **Under-deliver gracefully.** If the candidate pool is exhausted before reaching N, report `M found, N requested` and stop. Don't loop searching for more — ask the user to broaden the trade, location, or `min_rating` instead.
- **Respect robots.txt and ToS.** Don't scrape sources that forbid it.
- **No cold-outreach drafting unless asked.** This group finds leads. Drafting messages is a separate ask.
- **Privacy:** only collect business contact info, not personal data about employees unless it's publicly listed as a business contact.
- **Cite sources** in the CSV (the specific page URL where you found the contact info, not just the homepage) so the team can verify.

## When the ask is ambiguous

Ask one targeted question, not a questionnaire. Common gaps (trade and location should already be in the profile — don't re-ask those):
- **How many leads?** (5? 50?) — this is the most common gap. If N is missing, this is the only thing to ask before starting.
- **District/radius?** If the profile's location is "Paris, France" but the user wants only the 11e arrondissement, that's a one-time override for this run, not a profile change.
- **Filters that aren't in the profile yet?** If the user throws in "only solo operators" or "rating 4.5+", offer to save the filter to the profile so they don't have to repeat it (`Want me to save min_rating=4.5 to the profile for future runs?`).
