import { Client } from "@notionhq/client";
import { PageObjectResponse } from "@notionhq/client/build/src/api-endpoints";
import { getFirestore } from "firebase-admin/firestore";
import * as logger from "firebase-functions/logger";
import { calendar_v3 } from "googleapis";

import {
  deleteShiftEvent,
  eventIdForPage,
  upsertShiftEvent,
} from "./calendar";
import { listAllDataSourcePages, normalizeNotionId } from "./notion";
import { normalizePage } from "./normalize";
import { OrganizerShift, ShiftSyncConfig } from "./types";

export interface SyncDeps {
  notion: Client;
  calendar: calendar_v3.Calendar;
  config: ShiftSyncConfig;
}

// The ONLY collection this sync writes. Factotum's collections
// (hackathons/{id}/reminders, organizerMappings) are strictly off-limits so
// Discord reminder state can never be clobbered from here.
const shiftsCollection = (hackathonId: string) =>
  getFirestore()
    .collection("hackathons")
    .doc(hackathonId)
    .collection("shifts");

const upsertShift = async (
  deps: SyncDeps,
  shift: OrganizerShift,
): Promise<void> => {
  const docId = eventIdForPage(shift.notionPageId);
  await shiftsCollection(deps.config.hackathonId).doc(docId).set(shift);
  await upsertShiftEvent(deps.calendar, deps.config, shift);
  logger.info("Upserted shift", { docId, title: shift.title });
};

const removeShift = async (deps: SyncDeps, pageId: string): Promise<void> => {
  const docId = eventIdForPage(pageId);
  await shiftsCollection(deps.config.hackathonId).doc(docId).delete();
  await deleteShiftEvent(deps.calendar, deps.config, pageId);
  logger.info("Removed shift", { docId });
};

/**
 * Brings one page's downstream records up to date with its current Notion
 * state. `page` is the freshly-fetched page, or null if it no longer exists.
 * Shared by the webhook (per event) and reconciliation (per live page).
 */
export const syncPage = async (
  deps: SyncDeps,
  page: PageObjectResponse | null,
  pageId: string,
): Promise<void> => {
  // Deleted, trashed, or moved out of the active data source → tear down.
  if (!page || page.archived || page.in_trash) {
    await removeShift(deps, pageId);
    return;
  }
  const parentDataSourceId =
    page.parent.type === "data_source_id" ? page.parent.data_source_id : null;
  if (
    !parentDataSourceId ||
    normalizeNotionId(parentDataSourceId) !==
      normalizeNotionId(deps.config.notionDataSourceId)
  ) {
    await removeShift(deps, pageId);
    return;
  }

  const result = normalizePage(page);
  if (!result.ok) {
    // Incomplete rows are ignored — but if this shift synced before, its last
    // valid downstream state is deliberately kept (only deletion tears down).
    const docId = eventIdForPage(pageId);
    const existing = await shiftsCollection(deps.config.hackathonId)
      .doc(docId)
      .get();
    if (existing.exists) {
      logger.warn("Previously-synced shift became incomplete; keeping last valid state", {
        docId,
        reasons: result.reasons,
      });
    } else {
      logger.info("Ignoring incomplete draft row", {
        pageId,
        reasons: result.reasons,
      });
    }
    return;
  }

  await upsertShift(deps, result.shift);
};

export interface ReconcileSummary {
  livePages: number;
  synced: number;
  removedOrphans: number;
  failures: number;
}

/**
 * Full scan of the active data source: repairs missing or outdated Firestore
 * docs and Calendar events, and removes ones whose page is gone. Idempotent —
 * doc and event IDs derive from page IDs, so repeated runs never duplicate.
 * Used for initial sync, manual recovery, and the daily consistency check.
 */
export const reconcile = async (deps: SyncDeps): Promise<ReconcileSummary> => {
  const pages = await listAllDataSourcePages(
    deps.notion,
    deps.config.notionDataSourceId,
  );
  const summary: ReconcileSummary = {
    livePages: pages.length,
    synced: 0,
    removedOrphans: 0,
    failures: 0,
  };

  for (const page of pages) {
    try {
      await syncPage(deps, page, page.id);
      summary.synced += 1;
    } catch (error) {
      summary.failures += 1;
      logger.error("Reconcile failed for page", { pageId: page.id, error });
    }
  }

  // Docs whose page is no longer in the data source (deleted while the
  // webhook was down, or moved away) — tear them down.
  const liveDocIds = new Set(pages.map((page) => eventIdForPage(page.id)));
  const docs = await shiftsCollection(deps.config.hackathonId).get();
  for (const doc of docs.docs) {
    if (liveDocIds.has(doc.id)) continue;
    try {
      await removeShift(deps, doc.id);
      summary.removedOrphans += 1;
    } catch (error) {
      summary.failures += 1;
      logger.error("Reconcile failed to remove orphan", { docId: doc.id, error });
    }
  }

  logger.info("Reconcile complete", { ...summary });
  return summary;
};
