/**
 * Synthetic judge presets (Task 4 / plan.md §4).
 *
 * Every value is invented: no real credentials, people, patients or hosts. Each
 * preset is written to deterministically trip all three detection stages, so a
 * reviewer can see the whole pipeline (Regex → Entropy → BERT-NER) populate the
 * vault from one click:
 *
 *   1. crash log  → DB_URI (wins the overlap over the IP nested inside it),
 *                   PRIVATE_IP, AWS_KEY, EMAIL, HIGH_ENTROPY_SECRET (SESSION_SECRET),
 *                   PER + LOC via NER ("Marcus Wright", "Austin")
 *   2. support    → API_SECRET, PHONE (separator-formatted: the PHONE regex
 *                   requires a real separator), HIGH_ENTROPY_SECRET,
 *                   PER + ORG + LOC via NER ("Dana Voss", "Acme Gizmo Support", "Denver")
 *   3. medical    → JWT_TOKEN (real 3-part shape), PRIVATE_IP,
 *                   HIGH_ENTROPY_SECRET, PER + ORG via NER ("Elena", "Northside Medical Group")
 *
 * The entropy tokens are 30–31 distinct characters (≈4.9 bits/char), comfortably
 * over the 4.2 threshold, and none of them is a suffix of a regex-detected span
 * (Stage B must not double-claim what Stage A already owns).
 */

/** @type {Array<{id: string, label: string, buttonLabel: string, text: string}>} */
const SAMPLE_PRESETS = [
  {
    id: 'crash-log',
    label: 'Production Crash Log & .env Leak',
    buttonLabel: 'Crash log + .env',
    text: `[2026-11-12T08:41:17.204Z] FATAL  api-worker-07 crashed — restarting in 2s
Error: connect ECONNREFUSED 192.168.1.44:5432
    at TCPConnectWrap.afterConnect (node:net:1244:16)
    at Zone.run (node:zone.js:166:14)

# .env snapshot attached to incident INC-3094 (keys rotated after this dump)
DATABASE_URL=postgres://admin:K9#mP2$vL8@192.168.1.44:5432/prod_users
AWS_ACCESS_KEY_ID=AKIAIOSFODNN7EXAMPLE
SESSION_SECRET=Xk7pQ2mZ9wL4nR8vT3yB6cH1jF5dG0s
NOTIFY_EMAIL=sarah.connor@cyberdyne-ind.com

Reported by Marcus Wright in Austin — needs a fix before the 09:00 standup.`,
  },
  {
    id: 'support-ticket',
    label: 'Customer Support Escalation Ticket',
    buttonLabel: 'Support ticket',
    text: `ESCALATION ESC-4491 · billing dispute · priority: high

Customer: Dana Voss (account 4471-8823) reports three duplicate charges on the
card ending 4242. Best contact number on file: +1 (415) 555-2671 (mobile),
weekday mornings only.
Shipping address of record: 2210 Arapahoe Street, Denver, CO 80202.

The payments service is still holding the live key from the last deploy:
STRIPE_LIVE_KEY=sk_live_51Nx92kL8mP2qR7vT9wX4yZ1a
INTERNAL_TRACE_TOKEN=8d2Kf9Qm4Xz7Tp1Wb6Rn3Vy5Lc0HjG3

Reassigning ESC-4491 to Acme Gizmo Support, the billing escalation queue —
please confirm the refund decision before Friday.`,
  },
  {
    id: 'medical-payload',
    label: 'Medical Portal Debug Payload',
    buttonLabel: 'Medical payload',
    text: `{
  "request_id": "req_8f21c",
  "endpoint": "/api/v2/portal/appointments",
  "patient": { "id": "PT-9931", "name": "Elena Ruiz", "dob": "1988-03-14" },
  "clinic": "Northside Medical Group",
  "callback_secret": "7fA3bQ9zL2mX6kP4wR8vT1yN5cH0jD",
  "authorization": "Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiJQVC05OTMxIiwibmFtZSI6IkVsZW5hIFJ1aXoiLCJleHAiOjE3MzEzNTA4MDB9.9kQ2xL8mN4vB6cD1eF5gH0jR7sT2aW",
  "debug_host": "192.168.4.17",
  "note": "originated from the portal frontend during appointment booking"
}`,
  },
]

export default SAMPLE_PRESETS
