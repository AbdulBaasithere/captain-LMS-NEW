# Captain LMS — Monitoring & Alerts System: Complete Setup & Architecture Guide

This document explains **how the Automated Course Monitoring & Email Notification System works under the hood** and provides a **complete step-by-step setup and configuration guide** from database migration through live email verification and daily scheduling.

> For a condensed CLI quick-reference, see [`docs/COURSE_MONITORING_DEPLOYMENT.md`](./COURSE_MONITORING_DEPLOYMENT.md).

---

## Part 1 — How It Works (Architecture & Lifecycle)

The system is split across four coordinated layers so that **no email credentials or service-role keys ever touch the browser**, **every alert is strictly deduplicated**, and **reminders stop automatically the moment a course reaches 100% completion**.

```text
┌───────────────────────────────────────────────────────────────────────────────┐
│ 1. EMPLOYEE ACTIVITY (Browser — Vue 3 + src/lib/monitoring.ts)                │
│    • Opens a lesson / video / PDF / presentation  (PlayerView.vue)            │
│    • Submits a quiz or practice quiz              (QuizView.vue / PracticeQuiz)│
│    • Completes a lesson or reaches 100% progress  (PlayerView.vue)            │
└───────────────────────────────┬───────────────────────────────────────────────┘
                                │ supabase.rpc('record_learning_activity', ...)
                                ▼
┌───────────────────────────────────────────────────────────────────────────────┐
│ 2. POSTGRESQL DATABASE & TRIGGERS (supabase/migrations/20261112_*.sql)        │
│    • Logs event into `learning_activity_logs`                                 │
│    • Updates `profiles.last_activity_at` & `course_enrolments`                │
│    • Detects `is_first_start` (course_start_notified_at IS NULL)              │
│    • `trg_video_completion_stop_reminders` & `trg_quiz_attempt_activity`:     │
│        - Automatically stamps `completed_at` and sets `reminders_stopped=true`│
│          as soon as all active lessons in the employee's track are completed. │
└───────────┬───────────────────────────────────────────────────┬───────────────┘
            │ Immediate (on first start)                        │ Daily Cron (pg_cron + pg_net)
            │ `action: 'course_started'`                        │ or Admin "Run Monitor Now"
            ▼                                                   │ `action: 'run_monitor'`
┌───────────────────────────────────────────────────────────────▼───────────────┐
│ 3. SUPABASE EDGE FUNCTION (`course-notification-monitor`)                     │
│    • Authenticates caller (`x-cron-secret`, `service_role`, or Admin/User JWT)│
│    • Reads singleton `notification_settings` & syncs `course_enrolments`      │
│    • Evaluates active (incomplete) enrolments (`monitor-logic.ts`)            │
│    • Resolves TO (Employee) + CC (HR + Reporting Manager)                     │
│    • Reserves unique `idempotency_key` in `email_notification_logs`           │
│    • Renders responsive HTML & plain-text email (`email-templates.ts`)        │
│    • Dispatches via Resend / SMTP / M365 Graph / Gmail API (`email-providers`)│
│    • Updates log status (`sent` or `failed`) + timestamps on `course_enrolments`
└───────────────────────────────┬───────────────────────────────────────────────┘
                                │
                                ▼
┌───────────────────────────────────────────────────────────────────────────────┐
│ 4. ADMIN DASHBOARD (`Admin → Monitoring & Alerts` — `/admin/monitoring`)      │
│    • Live KPIs (Sent, Inactive, Due Soon, Overdue, Failed Deliveries)         │
│    • Queues, Email Delivery History + HTML Preview + Failed Retry             │
│    • Enrolment Deadline / CC Overrides & Master Rules / Test Email Settings   │
└───────────────────────────────────────────────────────────────────────────────┘
```

### Key Files in the Codebase

| Layer | File Path | Responsibility |
| :--- | :--- | :--- |
| **Database Schema & RPCs** | `supabase/migrations/20261112_course_monitoring_notifications.sql` | Tables (`course_enrolments`, `learning_activity_logs`, `notification_settings`, `email_notification_logs`), profile columns (`email`, `manager_id`, `manager_email`, `hr_email`, `last_activity_at`), RLS policies, `sync_course_enrolments()`, `record_learning_activity()`, and DB triggers. |
| **Edge Function Entry** | `supabase/functions/course-notification-monitor/index.ts` | Caller authorization, `run_monitor`, `course_started`, `retry_failed`, and `send_test` actions, plus atomic idempotency slot reservation. |
| **Evaluation & Routing** | `supabase/functions/course-notification-monitor/monitor-logic.ts` | Pure deterministic rule engine (`isEnrolmentCompleted`, `evaluateEnrolment`, `resolveNotificationRecipients`). |
| **Email Rendering** | `supabase/functions/course-notification-monitor/email-templates.ts` | Responsive HTML + plain-text email templates for all 5 notification types (`course_start`, `inactivity_7d`, `deadline_reminder`, `course_overdue`, `manual_test`). |
| **Email Transport** | `supabase/functions/course-notification-monitor/email-providers.ts` | Server-side dispatchers for Resend, Corporate SMTP Relay, Microsoft 365 Graph API, and Google Workspace Gmail API. |
| **Frontend Helper** | `src/lib/monitoring.ts` | Calls `record_learning_activity`, triggers `course_started`, loads dashboard data (with safe schema fallback), invokes admin Edge Function actions. |
| **Employee Activity Hooks** | `src/views/employee/PlayerView.vue`, `src/views/employee/QuizView.vue`, `src/components/PracticeQuiz.vue` | Emits `lesson_view`, `progress_update`, `quiz_attempt`, `lesson_completed`, and `course_completed` events. |
| **Admin UI** | `src/views/admin/MonitoringView.vue`, `src/views/admin/EmployeeDetailView.vue` | Monitoring & Alerts dashboard (`/admin/monitoring`) and per-employee HR/Manager/Deadline configuration (`/admin/employees/:id`). |

---

### How Each Monitoring & Alert Rule Works

All rule evaluation is centralized in `evaluateEnrolment()` (`monitor-logic.ts`) and executed consistently for every non-completed enrolment:

#### 1. Automatic Completion Stop (Highest Priority)
An enrolment is immediately treated as completed—and **all alerts (`course_start`, inactivity, deadline reminders, and overdue) are permanently suppressed**—if **any** of the following is true (`isEnrolmentCompleted()`):
- `status === 'completed'`
- `completed_at !== null`
- `reminders_stopped === true`
- `progress_pct >= 100`

This happens automatically in two places:
1. **Real-time on lesson/course completion**: `record_learning_activity()` and database trigger `trg_video_completion_stop_reminders` (fires on `video_completions` insert/update where `completed = true`) compute total active lessons vs. completed lessons for the employee's department track and set `status = 'completed'`, `progress_pct = 100`, `completed_at = now()`, and `reminders_stopped = true`.
2. **Manual override**: Admins can also toggle **Stop all pending reminders for this enrolment** inside the **Enrolments & Deadlines** edit modal.

#### 2. Immediate Course-Start Email (`course_start`)
- **When it fires**: As soon as an employee opens their first lesson in a course, `PlayerView.vue` calls `recordLearningActivity(...)`.
- **How it avoids repeats**: `record_learning_activity()` returns `is_first_start: true` only when `course_enrolments.course_start_notified_at IS NULL`. The frontend immediately invokes the Edge Function with `{ action: 'course_started', user_id, course_id }`.
- **Safety net**: If the immediate browser call fails (e.g., offline or closed tab), the daily `run_monitor` job also checks for started, incomplete enrolments where `course_start_notified_at IS NULL` and sends it cleanly.
- **Idempotency key**: `course_start:<user_id>:<course_id>`

#### 3. Inactivity Reminder & Activity Reset (`inactivity_7d`)
- **Threshold**: Configurable in **Settings & Test** (`inactivity_days`, default **`7` consecutive days**, range 1–90).
- **Anchor timestamp**: Uses `last_activity_at ?? started_at ?? enrolled_at`.
- **Trigger condition**: Whole UTC calendar days since the anchor timestamp is `>= inactivity_days`, AND the course is not completed, AND the course has not already sent an inactivity alert for that same anchor (`last_inactivity_notified_at < anchor`).
- **Automatic reset**: Any new `lesson_view`, `progress_update`, `lesson_completed`, or `quiz_attempt` updates `last_activity_at = now()`. Because `last_activity_at` is now newer than `last_inactivity_notified_at`, the idle clock resets cleanly to 0 days. If the employee stays inactive for another `N` days without finishing, a new reminder is allowed for the new `anchorDate`.
- **Idempotency key**: `inactivity_<inactivity_days>d:<user_id>:<course_id>:<anchorDateUTC>`

#### 4. Upcoming Deadline Reminders (`deadline_reminder`)
- **Intervals**: Configurable in **Settings & Test** (`reminder_days`, default **`7, 3, 1`** days before `deadline_date`, sorted descending).
- **Trigger condition**: Computed strictly in UTC dates (`deadlineUtcDay - todayUtcDay = daysRemaining`):
  - **7 days before deadline**: Initial deadline reminder.
  - **3 days before deadline**: Follow-up reminder.
  - **1 day before deadline**: Highlighted as **FINAL REMINDER · 1 DAY LEFT** in urgent styling.
- **Idempotency key**: `deadline_<D>d:<user_id>:<course_id>:<deadline_date>`

#### 5. Overdue Escalation (`course_overdue`)
- **Trigger condition**: When `deadline_date < today (UTC)` (`daysRemaining < 0`) and the course is still incomplete.
- **Status sync**: Automatically updates `course_enrolments.status` from `not_started` / `in_progress` to `overdue`.
- **Idempotency key**: `overdue:<user_id>:<course_id>:<deadline_date>` (fires once per missed deadline date so inboxes are not flooded daily).

---

### How Recipients (TO & CC) Are Resolved

For every notification (`resolveNotificationRecipients()`):
- **TO (Primary Recipient)**:
  1. `profiles.email` for the enrolled employee.
  2. Automatic fallback to Supabase Auth (`auth.admin.getUserById(user_id)`) if `profiles.email` is empty.
- **CC (Stakeholders — automatically deduplicated & excludes the TO email)**:
  - **Assigned HR Representative** (first non-empty value wins):
    1. `course_enrolments.hr_email` (course-specific override)
    2. `profiles.hr_email` (employee-level HR contact)
    3. `notification_settings.default_hr_email` (organization-wide default HR CC)
  - **Reporting Manager** (first non-empty value wins):
    1. `course_enrolments.manager_email` (course-specific override)
    2. `profiles.manager_email` (employee-level manager email override)
    3. Linked manager's `profiles.email` via `profiles.manager_id`
    4. Active `manager`-role user in the same `department`

---

### How Duplicate Emails Are Strictly Prevented (Two-Layer Guard)

1. **Application Layer**: Before rendering an email, `evaluateEnrolment()` checks both `email_notification_logs.idempotency_key` history and `course_enrolments` state timestamps (`course_start_notified_at`, `last_inactivity_notified_at`, `reminders_stopped`, `completed_at`).
2. **Database Atomic Lock**: Before calling any email provider API, the Edge Function inserts a `pending` row into `email_notification_logs` with a `UNIQUE` constraint on `idempotency_key`. If two cron runs or a manual trigger collide simultaneously, PostgreSQL raises SQLSTATE `23505` (unique violation) on the second request and aborts the duplicate send before an email leaves the server.

---

## Part 2 — Complete Step-by-Step Setup & Configuration Guide

Follow these **6 steps** in order to go from initial setup to verified live email alerts.

### Step 1 — Run the Database Migration

1. Open your **Supabase Dashboard** → **SQL Editor**.
2. Open the file `supabase/migrations/20261112_course_monitoring_notifications.sql` in this repository, copy its full contents, paste into the SQL Editor, and click **Run**.
   *(The script is idempotent and safe to re-run.)*
3. Confirm under **Database → Tables** that these tables exist:
   - `course_enrolments`
   - `learning_activity_logs`
   - `notification_settings` (should contain 1 row with `id = 1`)
   - `email_notification_logs`
4. Run an initial sync to backfill existing employee enrolments, progress, and profile emails:
   ```sql
   select public.sync_course_enrolments(null);
   ```

---

### Step 2 — Configure Server-Side Email & Core Secrets

All credentials live **only** in Supabase Edge Function Secrets—never in frontend `.env` files or database tables.

#### 2A. Set Core Monitoring Secrets
Run in your terminal (with Supabase CLI linked to your project):

```bash
npx supabase secrets set \
  CRON_SECRET="$(openssl rand -hex 32)" \
  LMS_PUBLIC_URL="https://your-lms-domain.com" \
  ORGANIZATION_NAME="Captain LMS" \
  LMS_FROM_EMAIL="Captain LMS <lms@yourcompany.com>"
```

> **Important:** Save the generated `CRON_SECRET` value—you will paste it into the `pg_cron` SQL job in Step 4. (`SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY` are automatically injected by Supabase into Edge Functions.)

#### 2B. Choose & Configure **One** Corporate Email Provider

Note: Setting `EMAIL_PROVIDER` as an Edge Function secret overrides the DB provider choice; if you prefer switching providers dynamically from the Admin UI, you can configure secrets for your chosen provider and match **Email Service Provider** in **Admin → Monitoring & Alerts → Settings & Test**.

##### Option A — Resend API (Recommended for quick domain-verified setup)
1. Verify your sending domain in Resend and create an API key.
2. Set secrets:
   ```bash
   npx supabase secrets set \
     EMAIL_PROVIDER=resend \
     RESEND_API_KEY="re_xxxxxxxxxxxxxxxxxxxxxxxxx"
   ```

##### Option B — Corporate SMTP Relay (Exchange / Postfix / Google SMTP Relay / Amazon SES)
Uses `nodemailer` inside the Edge Function. Port `465` automatically enables TLS (`secure: true`); port `587` uses STARTTLS (`SMTP_SECURE="false"`).
```bash
npx supabase secrets set \
  EMAIL_PROVIDER=smtp \
  SMTP_HOST="smtp.office365.com" \
  SMTP_PORT="587" \
  SMTP_USER="lms@yourcompany.com" \
  SMTP_PASS="your-smtp-or-app-password" \
  SMTP_SECURE="false"
```

##### Option C — Microsoft 365 (Graph API, App-Only `Mail.Send`)
1. In **Azure Portal → Microsoft Entra ID → App registrations**, register an app.
2. Grant Application permission **`Mail.Send`** (Microsoft Graph) and click **Grant admin consent**.
3. Create a Client Secret and note `Tenant ID`, `Client ID`, `Client Secret`, and the licensed mailbox UPN (`M365_SENDER_USER`).
4. Set secrets:
   ```bash
   npx supabase secrets set \
     EMAIL_PROVIDER=m365 \
     M365_TENANT_ID="<azure-tenant-guid>" \
     M365_CLIENT_ID="<app-client-id>" \
     M365_CLIENT_SECRET="<client-secret>" \
     M365_SENDER_USER="lms@yourcompany.com"
   ```

##### Option D — Google Workspace (Gmail REST API OAuth2)
1. Enable **Gmail API** in Google Cloud Console and create an OAuth Client ID (`Desktop` or `Web` with OAuth Playground redirect).
2. Generate an offline `refresh_token` with scope `https://www.googleapis.com/auth/gmail.send` for the authorized sender account.
3. Set secrets:
   ```bash
   npx supabase secrets set \
     EMAIL_PROVIDER=google_workspace \
     GOOGLE_CLIENT_ID="<oauth-client-id>" \
     GOOGLE_CLIENT_SECRET="<oauth-client-secret>" \
     GOOGLE_REFRESH_TOKEN="<offline-refresh-token>"
   ```

---

### Step 3 — Deploy the `course-notification-monitor` Edge Function

Deploy with `--no-verify-jwt` because the function performs its own strict authorization check (`authenticateCaller`), supporting both `x-cron-secret` (for unattended `pg_cron` runs) and authenticated Admin/Employee JWTs (for UI calls):

```bash
npx supabase functions deploy course-notification-monitor --no-verify-jwt
```

---

### Step 4 — Enable `pg_cron` & `pg_net` and Schedule Daily Checks

1. In **Supabase Dashboard → Database → Extensions**, search for and enable:
   - **`pg_cron`**
   - **`pg_net`**
2. Open **SQL Editor** and run the following (replace `<YOUR_PROJECT_REF>` and `<YOUR_CRON_SECRET>`):

```sql
create extension if not exists pg_cron;
create extension if not exists pg_net;

-- Remove old schedule if re-running
select cron.unschedule('course-notification-monitor-daily')
where exists (select 1 from cron.job where jobname = 'course-notification-monitor-daily');

-- Schedule daily evaluation at 08:00 UTC
select cron.schedule(
  'course-notification-monitor-daily',
  '0 8 * * *',
  $$
  select net.http_post(
    url := 'https://<YOUR_PROJECT_REF>.supabase.co/functions/v1/course-notification-monitor',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'x-cron-secret', '<YOUR_CRON_SECRET>'
    ),
    body := jsonb_build_object('action', 'run_monitor', 'source', 'pg_cron')
  ) as request_id;
  $$
);
```

3. Verify the cron job is registered:
   ```sql
   select jobid, jobname, schedule, active from cron.job;
   ```
   *(After a scheduled run, you can inspect `cron.job_run_details` and `net._http_response` to confirm HTTP `200` responses.)*

---

### Step 5 — Configure Stakeholders & Deadlines in the Admin UI

1. **Assign Employee Deadlines & CC Contacts** (**Admin → Employees → Click an Employee**):
   - **Compliance deadline**: Set **Due date** and click **Save deadline** (updates both `profiles.due_date` and all incomplete `course_enrolments`).
   - **HR & Manager Email CC**:
     - Select a **Reporting manager** from active Manager/Admin users, and/or enter **Reporting manager email (override)**.
     - Enter **Assigned HR representative email**.
     - Click **Save CC contacts** (propagates automatically to incomplete enrolments).
2. **Per-Course Enrolment Overrides** (**Admin → Monitoring & Alerts → Enrolments & Deadlines**):
   - Click **Edit** on any employee/course row to customize a course-specific **Completion deadline**, **Assigned HR representative email (CC)**, **Reporting manager email (CC)**, or manually **Stop all pending reminders for this enrolment**.

---

### Step 6 — Configure Monitoring Rules & Verify Live Delivery

1. Log in as an **Admin** and open **Admin → Monitoring & Alerts** (`/admin/monitoring`).
   - *Note*: If Step 1's SQL migration was not run yet, an amber banner warns that monitoring tables are not initialized. Once migrated, the banner disappears and all actions unlock.
2. Open the **Settings & Test** tab and configure:
   - **Enable automated course monitoring & emails** (master on/off switch)
   - Individual toggles:
     - *Immediate email when employee starts first lesson*
     - *Inactivity reminder emails*
     - *Upcoming deadline reminder emails*
     - *Overdue escalation emails*
   - **Inactivity threshold (days)**: default `7`
   - **Deadline reminder intervals (days before)**: default `7, 3, 1`
   - **Authorized Sender Name** & **Authorized HR/LMS Sender Email**
   - **Default HR Representative CC Email** (used whenever an employee/enrolment has no custom HR email)
   - **Email Service Provider** (must match the secrets set in Step 2B)
   - **LMS Public Base URL** (used for `"Continue Course in LMS"` CTA buttons inside emails)
   - Click **Save Notification Settings**.
3. **Send a Verification Test Email**:
   - On the right-hand card (**Send Verification Test Email**), enter a **TO recipient email** and optional **CC emails**.
   - Click **Send Test Email**.
   - Confirm the email arrives in both TO and CC inboxes with proper branding and links.
4. **Sync & Dry-Check**:
   - Click **Sync Enrolments** at the top of the page to populate/refresh all department-assigned enrolments.
   - Click **Run Monitor Now** to run an immediate evaluation pass across active enrolments and check the **Email History** tab.

---

## Part 3 — Operating the Admin Dashboard (`/admin/monitoring`)

- **Top KPI Cards**: Live counts for **Emails Sent**, **Inactive (7+ days)**, **Due Soon (≤ 7 days)**, **Overdue Enrolments**, and **Failed Deliveries**.
- **Global Filter Bar**: Filter all tabs simultaneously by **Department**, **Employee**, **Alert Type**, **Delivery Status**, or **Search** text.
- **Tab 1 — `Alert Queues`**: Live operational queues showing which employees are currently flagged for **Inactivity**, **Upcoming Deadlines (≤ 7d)**, and **Overdue**, alongside their last activity date, deadline, and assigned CC emails.
- **Tab 2 — `Email History`**: Audit log of every `sent`, `failed`, `pending`, or `skipped` dispatch. Click **Preview** to inspect the exact rendered HTML email in a sandboxed modal, or **Retry** on any `failed` log entry after fixing a provider secret or email address.
- **Tab 3 — `Enrolments & Deadlines`**: Full lifecycle view showing progress %, status (`not_started`, `in_progress`, `completed`, `overdue`), and whether reminders are `Active` or `Stopped (Completed)`.
- **Tab 4 — `Settings & Test`**: Global rules, provider secret checklist reminder, live test email sender, and the **Recent Learning Activity Telemetry** stream (`lesson_view`, `progress_update`, `quiz_attempt`, `lesson_completed`, `course_completed`).

---

## Part 4 — Security & Troubleshooting

### Security Guarantees
- **Zero Secrets in Frontend**: Only `VITE_SUPABASE_URL` and `VITE_SUPABASE_ANON_KEY` exist in client builds. SMTP passwords, API keys, and OAuth refresh tokens live exclusively in Supabase Edge Function Secrets.
- **Row-Level Security (RLS)**:
  - *Employees* can only read their own enrolments, activity logs, and email logs.
  - *Managers* can only read records for employees in their department or direct reports (`manager_id = auth.uid()`).
  - *Admins* can manage all enrolments, settings, and delivery retries.
- **Edge Function Caller Auth**: `run_monitor`, `retry_failed`, and `send_test` return `401`/`403` unless called with a valid `x-cron-secret`, `service_role` token, or verified Admin JWT. `course_started` verifies that the authenticated user matches `user_id` (or is an Admin).

### Common Issues & Fixes

| Symptom | Likely Cause | Fix |
| :--- | :--- | :--- |
| Amber warning: *"Course monitoring database schema is not yet initialized"* | SQL migration hasn't been run on the connected Supabase project. | Run `supabase/migrations/20261112_course_monitoring_notifications.sql` in Supabase SQL Editor and refresh. |
| **Send Test Email** fails with *"Missing RESEND_API_KEY / SMTP_HOST / M365_* / GOOGLE_*"* | Secrets for the active provider were not set in Supabase. | Run `npx supabase secrets set ...` for the selected provider and redeploy if needed. |
| Daily cron does not fire | `pg_cron` or `pg_net` not enabled, or `x-cron-secret` mismatch. | Enable both extensions in Dashboard → Extensions, verify `CRON_SECRET` matches the SQL `x-cron-secret` header, and check `cron.job_run_details`. |
| Cron returns `401 Unauthorized` | Function deployed without `--no-verify-jwt` or wrong `CRON_SECRET`. | Redeploy with `npx supabase functions deploy course-notification-monitor --no-verify-jwt` and confirm `x-cron-secret`. |
| Employee did not receive an alert | Missing email on profile/auth, course already at `100%` / `reminders_stopped = true`, or already sent for the current window. | Check employee email in **Admin → Employees**, check **Enrolments & Deadlines** status, and inspect **Email History** for `skipped`/`failed` logs. |
| Duplicate reminder worries | N/A — blocked automatically. | `email_notification_logs.idempotency_key` has a PostgreSQL `UNIQUE` index; `23505` collisions abort duplicate sends safely. |
