import { Timestamp } from "firebase-admin/firestore";

/**
 * The shared Firestore contract with Factotum (see Factotum's
 * docs/notion-shift-sync-design.md). Written to
 * hackathons/{hackathonId}/shifts/{docId} where docId is the Notion page ID
 * with dashes stripped. Factotum reads these and never writes them; this sync
 * writes these and never touches Factotum's collections
 * (hackathons/{id}/reminders, organizerMappings).
 */
export interface OrganizerShift {
  notionPageId: string;
  title: string;
  description?: string;
  location?: string;
  notionUrl?: string;
  startTime: Timestamp;
  endTime: Timestamp;
  organizerEmails: string[];
  leadOrganizerEmails: string[];
  updatedAt: Timestamp;
}

/**
 * Active configuration at automationConfig/notionShiftSync. Switching
 * hackathons means editing this document, not redeploying.
 * hackathonId must equal the Discord guild's hackathonName in Factotum
 * (e.g. "cmd-f2026").
 */
export interface ShiftSyncConfig {
  enabled: boolean;
  hackathonId: string;
  notionDataSourceId: string;
  calendarId: string;
  timezone: string;
}
