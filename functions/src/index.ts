import { initializeApp } from "firebase-admin/app";
import * as logger from "firebase-functions/logger";
import { onRequest } from "firebase-functions/v2/https";
import { onSchedule } from "firebase-functions/v2/scheduler";

import { makeCalendarClient } from "./calendar";
import { getSyncConfig } from "./config";
import { requireEnv } from "./env";
import {
  makeNotionClient,
  retrievePage,
  verifyNotionSignature,
} from "./notion";
import { reconcile, SyncDeps, syncPage } from "./sync";

initializeApp();

// Secrets come from plain environment variables (functions/.env at deploy
// time) rather than Secret Manager for now — granting the runtime service
// account Secret Manager access needs project-admin rights we don't have in
// dev. Values are only read inside handlers so deploy-time analysis of this
// module never throws.

/** Null when the sync is disabled or unconfigured. */
const buildDeps = async (): Promise<SyncDeps | null> => {
  const config = await getSyncConfig();
  if (!config) return null;
  return {
    config,
    notion: makeNotionClient(requireEnv("NOTION_API_TOKEN")),
    calendar: makeCalendarClient(
      requireEnv("GOOGLE_OAUTH_CLIENT_ID"),
      requireEnv("GOOGLE_OAUTH_CLIENT_SECRET"),
      requireEnv("GOOGLE_OAUTH_REFRESH_TOKEN"),
    ),
  };
};

/**
 * Receives Notion webhook events. Events are treated purely as notifications:
 * the affected page is always re-fetched and synced from its latest state, so
 * duplicate and out-of-order deliveries are harmless.
 */
export const notionShiftWebhook = onRequest(async (req, res) => {
  if (req.method !== "POST") {
    res.status(405).send("method not allowed");
    return;
  }

  // One-time subscription handshake: Notion sends the verification token in
  // the body. Log it so it can be stored as the
  // NOTION_WEBHOOK_VERIFICATION_TOKEN secret (see README).
  if (req.body?.verification_token) {
    logger.info(
      "Notion webhook verification token received — store it as the NOTION_WEBHOOK_VERIFICATION_TOKEN secret",
      {
        verification_token: req.body.verification_token,
      },
    );
    res.status(200).send("ok");
    return;
  }

  if (
    !verifyNotionSignature(
      req.rawBody,
      req.header("x-notion-signature"),
      requireEnv("NOTION_WEBHOOK_VERIFICATION_TOKEN"),
    )
  ) {
    logger.warn("Rejected webhook with invalid signature");
    res.status(401).send("invalid signature");
    return;
  }

  const entity = req.body?.entity as { id?: string; type?: string } | undefined;
  if (entity?.type !== "page" || !entity.id) {
    res.status(200).send("ignored");
    return;
  }

  try {
    const deps = await buildDeps();
    if (!deps) {
      res.status(200).send("sync disabled");
      return;
    }
    // Unrelated pages are filtered inside syncPage via the parent
    // data-source check on the freshly-fetched page.
    const page = await retrievePage(deps.notion, entity.id);
    await syncPage(deps, page, entity.id);
    res.status(200).send("ok");
  } catch (error) {
    logger.error("Webhook processing failed", { pageId: entity.id, error });
    // 5xx → Notion retries the delivery.
    res.status(500).send("error");
  }
});

/**
 * Manual reconciliation for initial sync and recovery. Deployed private —
 * invoke with an identity token:
 *   curl -H "Authorization: Bearer $(gcloud auth print-identity-token)" <url>
 */
export const reconcileActiveSchedule = onRequest(
  { invoker: "private", timeoutSeconds: 540 },
  async (req, res) => {
    const deps = await buildDeps();
    if (!deps) {
      res.status(200).json({ skipped: "sync disabled or unconfigured" });
      return;
    }
    try {
      const summary = await reconcile(deps);
      res.status(summary.failures > 0 ? 500 : 200).json(summary);
    } catch (error) {
      logger.error("Reconciliation failed", { error });
      res.status(500).json({ error: "reconciliation failed" });
    }
  },
);

/** Daily consistency check — catches anything the webhook missed. */
export const reconcileDaily = onSchedule(
  {
    schedule: "every day 09:00",
    timeZone: "America/Vancouver",
    timeoutSeconds: 540,
  },
  async () => {
    const deps = await buildDeps();
    if (!deps) return;
    const summary = await reconcile(deps);
    if (summary.failures > 0 || summary.schemaProblems.length > 0) {
      // Throw so the run is marked failed — this is what log-based alerting
      // and Cloud Scheduler retry policies key off.
      throw new Error(
        `Daily reconcile finished with ${summary.failures} failure(s), ${summary.schemaProblems.length} schema problem(s)`,
      );
    }
  },
);
