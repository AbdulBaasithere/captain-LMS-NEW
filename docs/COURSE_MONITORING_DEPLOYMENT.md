# Automated Course Monitoring & Email Notification System — Deployment Guide

> **Note on Project Stack:** Inspection of this repository confirmed the LMS frontend is built with **Vue 3 + TypeScript + Pinia + Vite + Supabase** (not React). All database migrations, Edge Functions, email templates, activity tracking hooks, and admin UI views are integrated cleanly into the existing Vue 3 + Supabase architecture without altering or breaking any existing LMS features.

---

## 1. Architecture Summary

| Layer | File(s) | Purpose |
| :--- | :--- | :--- |
| **SQL Migration** | `supabase/migrations/20261112_course_monitoring_notifications.sql` | Adds `email`, `manager_id`, `manager_email`, `hr_email`, `last_activity_at` to `profiles`; creates `course_enrolments`, `learning_activity_logs`, `notification_settings`, `email_notification_logs`; configures strict RLS, `sync_course_enrolments()` RPC, `record_learning_activity()` RPC, and `trg_quiz_attempt_activity` trigger. |
| **Edge Function** | `supabase/functions/course-notification-monitor/` (`index.ts`, `monitor-logic.ts`, `email-templates.ts`, `email-providers.ts`) | Evaluates enrolments, resolves `TO` (employee) + `CC` (HR + Manager), enforces `idempotency_key` deduplication, renders responsive HTML emails, and dispatches via Resend, SMTP, Microsoft 365, or Google Workspace. |
| **Frontend Hooks** | `src/lib/monitoring.ts`, `src/views/employee/PlayerView.vue`, `src/views/employee/QuizView.vue`, `src/components/PracticeQuiz.vue` | Tracks `lesson_view`, `progress_update`, `quiz_attempt`, `lesson_completed`, and `course_completed`; triggers immediate `course_started` notification on first lesson start. |
| **Admin UI** | `src/views/admin/MonitoringView.vue`, `src/views/admin/EmployeeDetailView.vue` | Provides KPI dashboard (Sent, Inactive 7+d, Upcoming Deadlines, Overdue, Failed Deliveries), department/employee/type filters, delivery history with HTML preview & Retry, per-enrolment deadline & CC overrides, and provider/interval configuration. |

---

## 2. Database Migration Setup

1. Open your **Supabase Dashboard → SQL Editor**.
2. Paste and execute the full contents of:
   ```
   supabase/migrations/20261112_course_monitoring_notifications.sql
   ```
3. Verify the new tables exist under **Database → Tables**:
   - `course_enrolments`
   - `learning_activity_logs`
   - `notification_settings` (pre-seeded with singleton row `id = 1`)
   - `email_notification_logs`
4. Run initial enrolment sync in SQL Editor (optional, also runs automatically via Admin UI or daily cron):
   ```sql
   select public.sync_course_enrolments(null);
   ```

---

## 3. Configure Server-Side Secrets (Edge Function)

Never put API keys, SMTP passwords, OAuth client secrets, or `SUPABASE_SERVICE_ROLE_KEY` into frontend `VITE_*` variables or database tables.

Set secrets via Supabase CLI:

```bash
# Core function secrets (SUPABASE_URL & SUPABASE_SERVICE_ROLE_KEY are auto-injected by Supabase,
# or can be explicitly verified in Project Settings -> Edge Functions)
npx supabase secrets set \
  CRON_SECRET="$(openssl rand -hex 32)" \
  LMS_PUBLIC_URL="https://lms.yourcompany.com" \
  ORGANIZATION_NAME="Captain LMS" \
  LMS_FROM_EMAIL="Captain LMS <lms@yourcompany.com>"
```

Then configure **one** of the four authorized corporate email providers:

### Option A: Resend
```bash
npx supabase secrets set EMAIL_PROVIDER=resend RESEND_API_KEY="re_xxxxxxxxx"
```

### Option B: Corporate SMTP Relay (e.g., Exchange / Postfix / Google SMTP Relay)
```bash
npx supabase secrets set \
  EMAIL_PROVIDER=smtp \
  SMTP_HOST="smtp.office365.com" \
  SMTP_PORT="587" \
  SMTP_USER="lms@yourcompany.com" \
  SMTP_PASS="app-or-smtp-password" \
  SMTP_SECURE="false"
```

### Option C: Microsoft 365 (Graph API — App-Only `Mail.Send`)
```bash
npx supabase secrets set \
  EMAIL_PROVIDER=m365 \
  M365_TENANT_ID="<azure-tenant-guid>" \
  M365_CLIENT_ID="<app-registration-client-id>" \
  M365_CLIENT_SECRET="<client-secret>" \
  M365_SENDER_USER="lms@yourcompany.com"
```

### Option D: Google Workspace (Gmail REST API OAuth2)
```bash
npx supabase secrets set \
  EMAIL_PROVIDER=google_workspace \
  GOOGLE_CLIENT_ID="<oauth-client-id>" \
  GOOGLE_CLIENT_SECRET="<oauth-client-secret>" \
  GOOGLE_REFRESH_TOKEN="<offline-refresh-token>"
```

---

## 4. Deploy the Edge Function

```bash
npx supabase functions deploy course-notification-monitor --no-verify-jwt
```
> `--no-verify-jwt` allows Supabase `pg_cron` requests authenticated by your strong `CRON_SECRET` header (`x-cron-secret`) as well as authenticated Supabase user/admin JWTs verified inside the function handler itself (`authenticateCaller`).

---

## 5. Schedule Daily Monitoring via Supabase Cron

1. In **Supabase Dashboard → Database → Extensions**, enable **`pg_cron`** and **`pg_net`**.
2. Execute the following SQL in the SQL Editor (replacing `<YOUR_PROJECT_REF>` and `<YOUR_CRON_SECRET>`):

```sql
select cron.unschedule('course-notification-monitor-daily')
where exists (select 1 from cron.job where jobname = 'course-notification-monitor-daily');

select cron.schedule(
  'course-notification-monitor-daily',
  '0 8 * * *', -- Runs daily at 08:00 UTC
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

---

## 6. Security & RLS Verification Checklist

- **Browser Bundle Isolation**: Only `VITE_SUPABASE_URL` and `VITE_SUPABASE_ANON_KEY` exist in frontend code. Zero SMTP/OAuth/API secrets or service-role keys are exposed.
- **Role-Based Access Control (RLS)**:
  - `course_enrolments`: Employees read own rows; Managers read their department or direct reports (`manager_id = auth.uid()`); Admins manage all rows.
  - `learning_activity_logs`: Authenticated users insert/read own logs; Managers read team logs; Admins read all logs.
  - `notification_settings`: Authenticated users read non-secret config; Admins update.
  - `email_notification_logs`: Employees read own delivery history; Managers read team logs; Admins read/manage all logs; Edge Function inserts via `service_role`.
- **Caller Authorization in Edge Function**:
  - `course_started`: verifies JWT `auth.uid() === payload.user_id` or `admin` role.
  - `run_monitor`, `retry_failed`, `send_test`: rejects unauthenticated or non-admin callers (`401`/`403`) unless valid `x-cron-secret` or `service_role` key is presented.
- **Duplicate Prevention**: Enforced both in pure evaluation (`evaluateEnrolment` + `last_inactivity_notified_at` / `course_start_notified_at`) AND atomically at DB level via `email_notification_logs.idempotency_key UNIQUE` constraint (`23505` conflict guard).

---

## 7. Automated Test Cases (`tests/monitoring.test.ts`)

Run unit tests locally:
```bash
node --experimental-strip-types --test tests/monitoring.test.ts
```

Verified scenarios:
1. Immediate `course_start` email on first lesson start + idempotency key deduplication.
2. Detection of 7 consecutive days of inactivity + suppression of duplicate alerts during the same idle window.
3. Inactivity timer reset when an employee resumes learning (`last_activity_at` advances past `last_inactivity_notified_at`).
4. Deadline reminders triggered strictly at `7`, `3`, and `1` days prior to assigned deadline.
5. Overdue notification triggered after deadline expires without duplicates.
6. Immediate suppression of all pending reminders when course reaches `100%` completion (`status = 'completed'`, `completed_at IS NOT NULL`, or `reminders_stopped = true`).
7. Recipient routing (`TO` employee, `CC` assigned HR + reporting manager, deduplicated and never duplicating `TO` in `CC`).
8. HTML & plain-text email rendering containing Employee, Course, Progress %, Last Activity, Deadline, and LMS Course URL with HTML escaping.
