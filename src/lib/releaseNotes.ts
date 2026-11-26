export interface ReleaseNote {
  version: string
  date: string // YYYY-MM-DD
  title: string
  changes: string[]
}

// Newest first. Add a new entry here whenever APP_VERSION is bumped in version.ts.
export const RELEASE_NOTES: ReleaseNote[] = [
  {
    version: 'v5.1',
    date: '2026-11-26',
    title: 'Captain Academy, Interactive Onboarding Tour & AI Quiz Customisation',
    changes: [
      'Captain Academy (Employee) — New dedicated Tutorials & Guides section (/app/tutorials): browse, search, and filter published video tutorials by category; track progress per tutorial (Not Started → In Progress → Completed); open a full Tutorial Player page with an embedded video and written step-by-step instructions.',
      'Captain Academy (Admin) — Full tutorial management at /admin/tutorials: create, edit, delete, publish and unpublish tutorials; upload videos to Supabase Storage or link external video URLs; assign categories, thumbnail images, durations and department visibility; view view-counts and employee completion analytics per tutorial.',
      'Captain Academy — 11 built-in screen-recorded demo tutorials covering every section of the app (Employee: Dashboard, Course Catalog, Lesson Player, Academy, Badges & Certificates, Account; Admin: Analytics, Employees & Audiences, Courses & Modules, Academy, Monitoring & Settings).',
      'Interactive Onboarding Tour — First-login guided walkthrough auto-opens for new employees (7 steps) and admins (5 steps); each step navigates the app in the background, plays the matching Academy tutorial video, lists the key components on screen, and explains how to use them.',
      'Onboarding Tour Replay — "Show Walkthrough & Demo Again" button added to the Employee Account settings page; "Show Admin Demo Tour Again" button added to Admin Dashboard Settings so users can re-watch the tour at any time.',
      'AI Quiz Generator — Removed "Google Gemini · free tier" branding; generator now labelled "AI Quiz Generator · Gemini". Admins can customise generation: choose the number of questions (3–30), select difficulty mode (Mixed / Easy / Medium / Hard), and add free-text instructions to steer the AI output.',
      'AI Quiz Generator — Added a model fallback cascade (gemini-4-hydrogen → gemini-2.5-flash → gemini-2.5-flash-lite → gemini-2.5-pro) with a 2-attempt retry and 1.2-second backoff on each transient 503/UNAVAILABLE error, eliminating "high demand" failures and showing a friendly "temporarily busy" message if all retries are exhausted.',
    ],
  },
  {
    version: 'v5.0',
    date: '2026-11-17',
    title: 'Admin Credentials & Assignments, KPI Analytics, Badge Criteria & Organization Leaderboard',
    changes: [
      'Admin side — Certificates (Create, Issue & PDF Templates): Added a Create & Issue Certificates tab alongside Template & PDF Settings (classic styling and custom uploaded PDF template alignment tool). Admins can issue official certificates to one or multiple employees with optional course links, credit hours, citations, PDF preview/download, and revocation.',
      'Admin side — Badges & Milestone Criteria: Added Milestone Eligibility Rules (based on completed course duration, courses completed, and certificates earned with All/Any matching) plus Custom Recognition Badges that admins can create, directly award to employees with citation notes, and revoke.',
      'Admin side — Course Assignments & Deadlines: Added multi-employee Assign buttons in Courses, an Assigned Employees management table in the Course Editor, and an Assigned Courses panel in Employee Detail profiles to assign courses across departments, update deadlines, and unassign learners.',
      'Admin side — Audiences & Automatic Course Colours: Added colour management directly inside Audiences (new audiences automatically receive an unused palette colour) and removed manual colour selection from Courses so courses inherit their audience colour automatically.',
      'Admin side — Bulk Employee Import via Resend & Retry: Switched employee invite delivery to Resend (removing Supabase 2-email/hour bulk import limits), improved invite endpoint diagnostics and retry handling, and added a Retry Failed Invites button to re-trigger invitations only for failed CSV rows.',
      'Admin side — KPI Analytics, Monitoring & Uploaded Videos: Added interactive Recharts KPI dashboards (completion trends, compliance distribution, quiz performance, and active user trends) with date-range and department filtering, a Monitoring & Alerts workspace for inactivity/deadline emails and HR/Manager CC contacts, and direct video file uploads on lessons.',
      'Admin & HR Portals — HR Portal & Organization Leaderboard: Added read-only HR routes (/hr/overview KPI analytics and /hr/compliance alerts) and launched the Organization Leaderboard (/admin/leaderboard, /hr/leaderboard, /manager/leaderboard, /app/leaderboard) ranking active learners by badges, course completions, and recent activity.',
      'Employee side — Certificates & Badges Hub: Added a metrics summary strip (course duration, courses completed, total certificates), Milestone & Achievement Badges with per-criterion progress bars and All/Unlocked/In-progress filters, Special Recognition Badges with admin citations, Awarded Certificates with PDF download/preview, and hover/focus tooltips on Milestone Quiz Badges showing unlock steps (when locked) or passing score/attempt/date (when unlocked).',
      'Employee side — Assigned Courses & Cross-Department Access: Updated Dashboard, Course Catalog, My Modules, and the Lesson Player to load courses and lessons explicitly assigned by an admin across departments, display Assigned and Due date tags, and provide an Assigned to me filter.',
      'Employee side — Organization Leaderboard Upgrade: Upgraded /app/leaderboard to show personal standing, 7d / 30d / All-time period filters, department filter, search, transparent Scoring Guide breakdown, and expandable learner breakdown details.',
    ],
  },
  {
    version: 'v4.3',
    date: '2026-10-15',
    title: 'Revamp phase 5: admin analytics and manager team views',
    changes: [
      'Admin Overview is now Analytics: company stat tiles, completion by department, a course funnel (switch between Compare and Rates), a when-people-learn heatmap, compliance tracker with Remind all overdue, and content health.',
      'Manager Team progress with status filters, sortable progress table and at-risk / overdue flags, plus a Team heatmap of people by course.',
      'Each widget can be hidden per role in Admin → Dashboard settings.',
      'Managers and admins reading team activity needs the one-time SQL in supabase/revamp-v4.sql.',
    ],
  },
  {
    version: 'v4.2',
    date: '2026-10-15',
    title: 'Revamp phase 4: learner dashboard, leaderboard podium and deadlines',
    changes: [
      'New employee dashboard: continue-learning card, stat tiles with learning streak, My courses, due this week and recent activity.',
      'Weekly goal in the sidebar, fed by study time recorded while you watch lessons.',
      'Leaderboard redesigned as a podium for the top three, with your own row highlighted.',
      'New Deadlines calendar showing your due date, quizzes ready and what you\'ve completed.',
      'New Admin → Dashboard settings page: switch each widget on or off per role (Employee, Manager, Admin); hidden pages disappear from the menu.',
    ],
  },
  {
    version: 'v4.1',
    date: '2026-10-15',
    title: 'Revamp phases 2-3: courses, catalog and course player',
    changes: [
      'New Course catalog with colourful course cards, category filters and search.',
      'Courses group lessons (modules); admins manage them in Admin → Courses, including colour, category, publishing and lesson order.',
      'New course player: lesson list with progress, previous/next lesson, and a practice quiz drawn from the course\'s question banks.',
      'Needs the one-time SQL in supabase/revamp-v4.sql; until it is run, one automatic course per audience is shown.',
    ],
  },
  {
    version: 'v4.0',
    date: '2026-10-15',
    title: 'Revamp phase 1: new design system',
    changes: [
      'New look across the whole app: navy sidebar, light content area, blue and orange accents, rounded cards and a new font.',
      'Dark mode kept and refreshed to match.',
      'Redesigned sign-in screen.',
    ],
  },
  {
    version: 'v3.1',
    date: '2026-10-15',
    title: 'Sortable tables',
    changes: [
      'Click any column heading to sort the Employees, admin Modules and employee My Modules tables; click again to reverse. Empty values always sort last.',
    ],
  },
  {
    version: 'v3.0',
    date: '2026-10-15',
    title: 'Release notes page',
    changes: ['New admin-only Release notes page listing every version with its date and what changed.'],
  },
  {
    version: 'v2.9',
    date: '2026-10-14',
    title: 'Avatar initials',
    changes: [
      'Avatar initials now come from the signed-in person’s real name in every sidebar and list (the admin sidebar was stuck on "PN").',
      'Editing your own name or role refreshes the sidebar straight away.',
    ],
  },
  {
    version: 'v2.8',
    date: '2026-10-14',
    title: 'Employee management',
    changes: [
      'Add a single employee (name, email, department, role) with an invite email.',
      'Edit an employee’s name and role from their page, which also shows their email and last sign-in.',
      'Deactivate / reactivate employees: they can’t sign in and are hidden from the leaderboard, team lists, overview counts and weekly digest, but their history is kept.',
      'Delete an employee permanently, with a confirmation. You can’t deactivate or delete yourself or the last active admin.',
      'Sign-ups can no longer claim an admin or manager role; roles are set by admins on the server.',
    ],
  },
  {
    version: 'v2.7',
    date: '2026-10-14',
    title: 'Delete and unpublish modules',
    changes: [
      'Admins can delete a module (with its questions, uploaded file and completion records) after a confirmation.',
      'Publish / Unpublish and Delete buttons added to every row of the module list.',
    ],
  },
  {
    version: 'v2.6',
    date: '2026-10-14',
    title: 'AI generator: faster model choice',
    changes: ['The question generator now starts with a light Gemini model and tries lighter, more settled models before the newest ones. Generation dropped from 20+ seconds to about 10.'],
  },
  {
    version: 'v2.5',
    date: '2026-10-14',
    title: 'AI generator: clearer failures',
    changes: ['Each model attempt is time-capped, and failures list which models were tried and why.'],
  },
  {
    version: 'v2.4',
    date: '2026-10-14',
    title: 'AI generator: model compatibility',
    changes: ['Requests fall back to simpler options when a Gemini model rejects the speed setting or strict output format, then try other models.'],
  },
  {
    version: 'v2.3',
    date: '2026-10-14',
    title: 'AI generator: overload handling and YouTube links',
    changes: [
      'Switches to another model when Gemini is overloaded, within a 24-second budget.',
      'YouTube links are accepted wherever a video ID is asked for, and are converted to the 11-character ID on save.',
    ],
  },
  {
    version: 'v2.2',
    date: '2026-10-14',
    title: 'AI generator: model auto-detection',
    changes: ['If the configured Gemini model is retired or unavailable, the generator finds a working Flash model automatically.'],
  },
  {
    version: 'v2.1',
    date: '2026-10-14',
    title: 'AI generator: real error messages',
    changes: ['Shows Google’s actual error, retries once on temporary overloads, and offers a paste-transcript box for videos that can’t be read.'],
  },
  {
    version: 'v2.0',
    date: '2026-10-14',
    title: 'AI question generator',
    changes: [
      'New "Generate questions from this material" card on each module: 15 questions (5 easy, 6 medium, 4 hard) drafted by Google Gemini’s free tier from the uploaded PDF, DOCX, PPTX or YouTube video.',
      'Review, edit or untick questions before adding them to the bank; add to or replace the existing questions.',
      'After creating a module with material, you’re offered to generate its questions straight away.',
    ],
  },
  {
    version: 'v1.9',
    date: '2026-08-28',
    title: 'Audiences page and employee module table',
    changes: [
      'Audiences (departments) moved to their own admin sidebar page.',
      'Employees’ My Modules is now a table (Title, Audience, Type, Duration, Status) with an All / General / your-department filter.',
    ],
  },
  {
    version: 'v1.8',
    date: '2026-08-28',
    title: 'Version tag placement',
    changes: ['The version tag moved next to Sign out so it never overlaps other content.'],
  },
  {
    version: 'v1.7',
    date: '2026-08-28',
    title: 'Tighter skip-blocking and type/duration columns',
    changes: ['Video skip-blocking reacts faster and allows less drift.', 'Type and duration are shown in every module list.'],
  },
  {
    version: 'v1.6',
    date: '2026-08-28',
    title: 'Document sizing and per-module quiz toggle',
    changes: ['The document viewer scales to the screen size.', 'Admins can choose whether a General module needs a quiz.'],
  },
  {
    version: 'v1.5',
    date: '2026-08-27',
    title: 'One quiz per General module',
    changes: [
      'Each General module gets its own quiz; department modules keep the quiz after every 5.',
      'Changing an employee’s department now clears their old training history (with a confirmation).',
    ],
  },
  {
    version: 'v1.4',
    date: '2026-08-27',
    title: 'Notifications',
    changes: ['Notifications moved to a sidebar row and open in a centered pop-up.'],
  },
  {
    version: 'v1.0 – v1.3',
    date: '2026-08-26',
    title: 'First release and foundations (26–27 Aug 2026)',
    changes: [
      'Employee, manager and admin sign-in with department-based module tracks, built on Vue, Supabase and Netlify.',
      'Visual design matched to the Captain LMS demo.',
      'Quiz engine with timed questions, attempt limits and cooldown; question bank editor with bulk paste.',
      'Badges, certificates, and a leaderboard with period and department filters.',
      'Real watch-time tracking with skip-blocking and a locked-down video player; documents (PDF, PPTX, DOCX) as an alternative to video.',
      'CSV employee import, scheduled publishing, compliance deadlines, announcements, captions toggle and the weekly digest.',
      'Editable audiences and a full module detail page; admins can grant extra quiz attempts.',
    ],
  },
]
