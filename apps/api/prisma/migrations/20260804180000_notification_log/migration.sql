-- Every notification the app raised, whether or not anything carried it away.
--
-- Until now these existed only as a push. `NotifierService.send` resolved a webhook and
-- returned early when there was none — so on an install with no ntfy topic and no Discord
-- URL, which is the default, every notification was composed and then dropped on the
-- floor. That includes the sunset daily summary, which is not an alert and appears nowhere
-- else in the app: its entire existence was a message to a phone that was never sent.
--
-- Recording before delivery rather than after is the point. A row here is "the app had
-- something to tell you", which is true regardless of whether a webhook existed, was
-- reachable, or returned 500 — and `deliveredAt` carries the difference rather than
-- collapsing it into "no record at all".
CREATE TABLE "Notification" (
  "id"          INTEGER  NOT NULL PRIMARY KEY AUTOINCREMENT,
  "raisedAt"    DATETIME NOT NULL,
  "title"       TEXT,
  "body"        TEXT     NOT NULL,
  "tags"        TEXT,
  -- Null while undelivered: no webhook configured, or the attempt failed. `error` says
  -- which, and null in both columns means nowhere to send it rather than a failure.
  "deliveredAt" DATETIME,
  "error"       TEXT
);

-- Read newest-first, always.
CREATE INDEX "Notification_raisedAt_idx" ON "Notification"("raisedAt");
