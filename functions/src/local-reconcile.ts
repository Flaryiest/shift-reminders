/**
 * Dev utility: runs reconciliation locally, without deployed functions.
 * Requires the same env vars as the functions (see .env.example) plus a
 * service-account JSON in FIREBASE_SERVICE_ACCOUNT or
 * DEV_FIREBASE_SERVICE_ACCOUNT for Firestore access.
 *
 *   npm run build
 *   node --env-file=.env [--env-file=<file with service account>] \
 *     lib/local-reconcile.js [--dry-run]
 *
 * --dry-run only reports what each Notion row would do — no Firestore or
 * Calendar writes, and no invites. ALWAYS dry-run first: a real run sends
 * actual Calendar invites to every person on eligible rows.
 */
import { cert, deleteApp, getApp, initializeApp } from "firebase-admin/app";
import { getFirestore } from "firebase-admin/firestore";

import { makeCalendarClient } from "./calendar";
import { getSyncConfig } from "./config";
import { requireEnv } from "./env";
import { listAllDataSourcePages, makeNotionClient } from "./notion";
import { normalizePage } from "./normalize";
import { reconcile } from "./sync";

const main = async (): Promise<void> => {
  const dryRun = process.argv.includes("--dry-run");
  // DEV_ deliberately wins: Factotum's .env carries both, and a local dev
  // utility must never silently target production.
  const serviceAccountJson =
    process.env.DEV_FIREBASE_SERVICE_ACCOUNT ??
    process.env.FIREBASE_SERVICE_ACCOUNT;
  if (serviceAccountJson) {
    const serviceAccount = JSON.parse(serviceAccountJson);
    console.log(`Firestore project: ${serviceAccount.project_id}`);
    initializeApp({ credential: cert(serviceAccount) });
  } else {
    initializeApp();
  }

  const config = await getSyncConfig();
  if (!config) throw new Error("Sync is disabled or unconfigured");
  const notion = makeNotionClient(requireEnv("NOTION_API_TOKEN"));

  if (dryRun) {
    const pages = await listAllDataSourcePages(
      notion,
      config.notionDataSourceId,
    );
    console.log(
      `DRY RUN — ${pages.length} page(s) in the data source, nothing written:`,
    );
    for (const page of pages) {
      const result = normalizePage(page);
      if (result.ok) {
        const { shift } = result;
        const invitees = [
          ...new Set([...shift.organizerEmails, ...shift.leadOrganizerEmails]),
        ];
        console.log(
          `  would sync "${shift.title}": ${shift.startTime.toDate().toISOString()} → ${shift.endTime.toDate().toISOString()}, ` +
            `would invite: ${invitees.join(", ") || "(nobody)"}`,
        );
      } else {
        console.log(`  would skip (incomplete): ${result.reasons.join("; ")}`);
      }
    }
    return;
  }

  const calendar = makeCalendarClient(
    requireEnv("GOOGLE_OAUTH_CLIENT_ID"),
    requireEnv("GOOGLE_OAUTH_CLIENT_SECRET"),
    requireEnv("GOOGLE_OAUTH_REFRESH_TOKEN"),
  );
  const summary = await reconcile({ notion, calendar, config });
  console.log("Reconcile summary:", summary);
};

main().then(
  // Wind Firestore down instead of process.exit — a hard exit mid-teardown
  // trips a libuv assertion on Windows.
  async () => {
    await getFirestore().terminate();
    await deleteApp(getApp());
  },
  (error) => {
    console.error(error);
    process.exit(1);
  },
);
