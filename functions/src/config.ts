import { getFirestore } from "firebase-admin/firestore";
import * as logger from "firebase-functions/logger";

import { ShiftSyncConfig } from "./types";

/**
 * Loads the active sync configuration. Returns null (with the reason logged)
 * when the sync should not run — missing config, disabled, or incomplete.
 */
export const getSyncConfig = async (): Promise<ShiftSyncConfig | null> => {
  const snapshot = await getFirestore()
    .doc("automationConfig/notionShiftSync")
    .get();
  const config = snapshot.data() as Partial<ShiftSyncConfig> | undefined;
  if (!config) {
    logger.warn("automationConfig/notionShiftSync does not exist — sync idle");
    return null;
  }
  if (!config.enabled) {
    logger.info("Shift sync is disabled in automationConfig/notionShiftSync");
    return null;
  }
  const missing = (
    ["hackathonId", "notionDataSourceId", "calendarId", "timezone"] as const
  ).filter((key) => !config[key]);
  if (missing.length > 0) {
    logger.error("Shift sync config is incomplete", { missing });
    return null;
  }
  return config as ShiftSyncConfig;
};
