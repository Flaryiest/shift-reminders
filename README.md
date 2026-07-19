# shift-reminders

Firebase Cloud Functions that keep the organizer shift schedule in sync:
**Notion is the only source of truth**, and this repo mirrors it one-way into

1. **Firestore** — `hackathons/{hackathonId}/shifts/{id}`, which
   [Factotum](https://github.com/nwplus/Factotum) reads to ping organizers 10
   minutes before their shift, and
2. **Google Calendar** — one event per shift, with assigned organizers as
   attendees.

```
Notion shift database
  │  webhook + daily reconcile
  ▼
notionShiftWebhook / reconcileActiveSchedule / reconcileDaily
  │                          │
  ▼                          ▼
Firestore                  Google Calendar
hackathons/{id}/shifts     event ID derived from the
(read by Factotum)         Notion page ID
```

Nothing ever flows the other way: Discord and Calendar cannot modify the
schedule, and this sync never touches Factotum's collections
(`hackathons/{id}/reminders`, `organizerMappings`).

## Functions

| Function | Trigger | Purpose |
| --- | --- | --- |
| `notionShiftWebhook` | HTTPS (public, signature-verified) | Reacts to Notion page events. Events are notifications only — the page is always re-fetched, so duplicates/out-of-order deliveries are harmless. Handles create, edit, delete, restore, and moves in/out of the data source. |
| `reconcileActiveSchedule` | HTTPS (private) | Full scan + repair: initial sync, manual recovery. Idempotent — doc/event IDs derive from page IDs. |
| `reconcileDaily` | Scheduler, 09:00 America/Vancouver | Daily consistency check; fails loudly if any page errors. |

## Configuration (no redeploy needed to switch hackathons)

One Firestore doc: `automationConfig/notionShiftSync`

```ts
{
  enabled: boolean;
  hackathonId: string;        // MUST equal the guild's hackathonName in Factotum, e.g. "cmd-f2026"
  notionDataSourceId: string; // the active shift database's data source ID
  calendarId: string;         // the "Hackathon Shifts Calendar" ID
  timezone: "America/Vancouver";
}
```

## Secrets (Firebase CLI — never in git)

```bash
firebase functions:secrets:set NOTION_API_TOKEN
firebase functions:secrets:set NOTION_WEBHOOK_VERIFICATION_TOKEN
firebase functions:secrets:set GOOGLE_OAUTH_CLIENT_ID
firebase functions:secrets:set GOOGLE_OAUTH_CLIENT_SECRET
firebase functions:secrets:set GOOGLE_OAUTH_REFRESH_TOKEN
```

### Getting the Google OAuth refresh token (one-time)

Use the dedicated nwPlus calendar account (`calendar@nwplus.io` or
`admin@nwplus.io` — needs pres sign-off), so invites are owned by nwPlus, not
an individual member.

1. In Google Cloud Console (same project), create an **OAuth client ID**
   (type: Web application, redirect URI `https://developers.google.com/oauthplayground`).
2. In the [OAuth playground](https://developers.google.com/oauthplayground):
   gear icon → "Use your own OAuth credentials" → paste client ID/secret →
   authorize scope `https://www.googleapis.com/auth/calendar` **while signed in
   to the calendar account** → exchange for tokens → copy the **refresh
   token**.
3. In that account, create a "Hackathon Shifts Calendar" and put its calendar
   ID (calendar settings → "Integrate calendar") into the config doc.

### Notion integration (one-time + per hackathon)

1. Create an internal Notion integration; give it read access and **user
   information including email addresses** (Person-property emails are usually
   organizers' *personal* emails — that's expected; Factotum's `/link-email`
   accepts any email).
2. **Each new hackathon's shift database must be connected to the integration**
   before enabling sync.
3. Create a webhook subscription pointed at the deployed `notionShiftWebhook`
   URL, subscribed to page events in the workspace. On creation Notion sends a
   `verification_token` — it appears in the function's logs; store it as the
   `NOTION_WEBHOOK_VERIFICATION_TOKEN` secret and verify the subscription in
   Notion's UI.

## Shift database expectations

Property names are constants in
[`functions/src/normalize.ts`](functions/src/normalize.ts) (`NOTION_PROPS`) —
all hackathons should duplicate the same template. **Verify the names match
the template before each event.** Current expectations:

| Property | Type | Notes |
| --- | --- | --- |
| `Event` | title | required |
| `Date/Time` | date | must have start **and** end |
| `Organizers` | people | at least one person across Organizers/Lead |
| `Lead` | people | optional |
| `Location` | multi-select | optional |
| `Notes` | rich text | optional; becomes the reminder/invite description |
| `Volunteers`, `Audience`, `Category`, `Announcement`, `Announcer`, `Social IG Story Person` | — | deliberately ignored |

Rows missing a title, valid start/end, or any assigned organizer are treated
as incomplete drafts and skipped. If a previously-synced shift *becomes*
incomplete, its last valid state is kept (with a logged warning) — only actual
deletion tears down the Firestore doc and Calendar event.

## Deploy & run

```bash
cd functions && npm install && npm run build   # verify locally
firebase deploy --only functions               # from repo root
# initial sync / manual recovery:
curl -H "Authorization: Bearer $(gcloud auth print-identity-token)" \
  https://<region>-<project>.cloudfunctions.net/reconcileActiveSchedule
```

## Setup before each hackathon

1. Logistics duplicates the shift database template in Notion.
2. Connect it to the Notion integration.
3. Update `automationConfig/notionShiftSync` (`hackathonId` = Factotum's
   `hackathonName`, new `notionDataSourceId`).
4. Set `enabled: true`; run `reconcileActiveSchedule`.
5. Test one shift end-to-end with real organizer accounts: Notion row →
   Firestore doc → Factotum reminder + Calendar invite.

## Logging & alerts

Everything logs through the Firebase logger. Recommended log-based alerts
(Cloud Logging → create alert on these):

- `Reconciliation failed` / `Daily reconcile finished with N failure(s)` — reconcile broke.
- `invalid_grant` or 401s from googleapis — the Google OAuth refresh token expired.
- `Rejected webhook with invalid signature` repeating — misconfigured webhook or probing.
- Notion `object_not_found`/`unauthorized` on the data source — integration lost access.
- Repeated `Reconcile failed for page` / Calendar 4xx — repeated Calendar failures.
