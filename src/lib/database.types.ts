// Hand-written types matching supabase/schema.sql.
// Once your Supabase project is live, regenerate this file with the real thing:
//   npx supabase gen types typescript --project-id <your-project-ref> > src/lib/database.types.ts

export type Role = 'employee' | 'hr' | 'admin' | 'manager'

export interface Profile {
  id: string
  full_name: string
  email?: string | null
  role: Role
  department: string
  due_date: string | null
  is_active?: boolean
  manager_id?: string | null
  manager_email?: string | null
  hr_email?: string | null
  last_activity_at?: string | null
  created_at: string
}

export interface Module {
  id: number
  title: string
  department: string
  youtube_id: string | null
  video_url?: string | null
  video_type?: string | null
  document_url: string | null
  document_type: string | null
  quiz_required: boolean
  duration_seconds: number
  is_draft: boolean
  scheduled_date: string | null
  is_archived: boolean
  course_id?: number | null
  lesson_order?: number
  created_by: string | null
  created_at: string
}

export type CourseDifficulty = 'Beginner' | 'Intermediate' | 'Advanced'

export interface Course {
  id: number
  title: string
  category: string
  difficulty?: CourseDifficulty | null
  description: string | null
  color: string
  is_published: boolean
  created_at: string
}

export interface QuizQuestion {
  id: number
  module_id: number
  question: string
  options: string[]
  correct_index: number
  created_at: string
}

export interface VideoCompletion {
  id: number
  user_id: string
  module_id: number
  watched_seconds: number
  completed: boolean
  completed_at: string | null
  last_watched_at?: string | null
}

export interface QuizAttempt {
  id: number
  user_id: string
  milestone: string
  attempt_number: number
  score: number
  total: number
  passed: boolean
  questions_snapshot: unknown
  created_at: string
}

export interface QuizAttemptGrant {
  id: number
  user_id: string
  milestone: string
  extra_attempts: number
  granted_by: string | null
  created_at: string
}

export interface Notification {
  id: number
  user_id: string
  text: string
  action: { type: 'open-quiz'; milestone: string } | { type: 'goto'; view: string } | null
  read: boolean
  created_at: string
}

export interface Announcement {
  id: number
  text: string
  created_by: string | null
  created_at: string
}

export interface ActivityLogEntry {
  id: number
  actor_id: string | null
  text: string
  created_at: string
}

export interface Department {
  id: number
  name: string
  color?: string | null
  created_at: string
}

export interface AudienceColorRow {
  audience_name: string
  color: string
  updated_at: string
}

export type EnrolmentStatus = 'not_started' | 'in_progress' | 'completed' | 'overdue'
export type LearningEventType =
  | 'lesson_view'
  | 'progress_update'
  | 'quiz_attempt'
  | 'lesson_completed'
  | 'course_completed'
export type EmailProviderType = 'resend' | 'smtp' | 'm365' | 'google_workspace'
export type EmailNotificationType =
  | 'course_start'
  | 'inactivity_7d'
  | 'deadline_reminder'
  | 'course_overdue'
  | 'manual_test'
export type EmailDeliveryStatus = 'pending' | 'sent' | 'failed' | 'skipped'

export interface CourseEnrolment {
  id: number
  user_id: string
  course_id: number
  assigned_by: string | null
  hr_email: string | null
  manager_email: string | null
  deadline_date: string | null
  status: EnrolmentStatus
  progress_pct: number
  enrolled_at: string
  started_at: string | null
  last_activity_at: string | null
  completed_at: string | null
  course_start_notified_at: string | null
  last_inactivity_notified_at: string | null
  reminders_stopped: boolean
  updated_at: string
}

export interface LearningActivityLog {
  id: number
  user_id: string
  course_id: number | null
  module_id: number | null
  event_type: LearningEventType
  progress_pct: number | null
  metadata: Record<string, unknown>
  created_at: string
}

export interface NotificationSettings {
  id: number
  enabled: boolean
  inactivity_days: number
  reminder_days: number[]
  send_course_start: boolean
  send_inactivity: boolean
  send_deadline_reminders: boolean
  send_overdue: boolean
  sender_name: string
  sender_email: string
  default_hr_email: string | null
  email_provider: EmailProviderType
  lms_base_url: string
  updated_by: string | null
  updated_at: string
}

export interface EmailNotificationLog {
  id: number
  user_id: string
  course_id: number | null
  enrolment_id: number | null
  notification_type: EmailNotificationType
  idempotency_key: string
  to_email: string
  cc_emails: string[]
  subject: string
  html_body: string | null
  provider: string | null
  provider_message_id: string | null
  status: EmailDeliveryStatus
  error_message: string | null
  metadata: Record<string, unknown>
  sent_at: string | null
  created_at: string
}

export interface CertificateSettingsRow {
  id: number
  config: Record<string, unknown>
  updated_by: string | null
  updated_at: string
}

export interface TrainingKpiTarget {
  id: number
  scope: string
  target_completion_pct: number
  target_pass_rate_pct: number
  target_compliance_pct: number
  target_learning_hours_monthly: number
  pass_threshold_pct: number
  updated_by: string | null
  updated_at: string
}

export type KpiReportScope = 'company' | 'department' | 'course' | 'employee'
export type KpiReportFormat = 'csv' | 'pdf'

export interface KpiReportExport {
  id: number
  exported_by: string
  exporter_role: string
  report_scope: KpiReportScope
  format: KpiReportFormat
  filters: Record<string, unknown>
  row_count: number
  created_at: string
}

export interface BadgeCriterionRow {
  id: number
  slug: string
  name: string
  description: string
  icon: string
  tier_order: number
  match_mode: 'all' | 'any'
  min_course_duration_minutes: number
  min_courses_completed: number
  min_certificates_earned: number
  is_active: boolean
  updated_by: string | null
  created_at: string
  updated_at: string
}

export interface IssuedCertificateRow {
  id: number
  certificate_code: string
  user_id: string
  title: string
  category: string
  description: string
  issued_date: string
  total_hours: number
  total_lessons: number
  course_id: number | null
  issued_by: string | null
  created_at: string
}

export interface CustomBadgeRow {
  id: number
  slug: string
  name: string
  description: string
  icon: string
  category: string
  is_active: boolean
  created_by: string | null
  created_at: string
  updated_at: string
}

export interface EmployeeBadgeAwardRow {
  id: number
  badge_id: number
  user_id: string
  reason: string
  awarded_by: string | null
  awarded_at: string
}

// Minimal shape Supabase's client generic needs — table name -> Row type.
export interface Database {
  public: {
    Tables: {
      profiles: { Row: Profile; Insert: Partial<Profile>; Update: Partial<Profile> }
      modules: { Row: Module; Insert: Partial<Module>; Update: Partial<Module> }
      quiz_questions: {
        Row: QuizQuestion
        Insert: Partial<QuizQuestion>
        Update: Partial<QuizQuestion>
      }
      video_completions: {
        Row: VideoCompletion
        Insert: Partial<VideoCompletion>
        Update: Partial<VideoCompletion>
      }
      quiz_attempts: { Row: QuizAttempt; Insert: Partial<QuizAttempt>; Update: Partial<QuizAttempt> }
      quiz_attempt_grants: {
        Row: QuizAttemptGrant
        Insert: Partial<QuizAttemptGrant>
        Update: Partial<QuizAttemptGrant>
      }
      notifications: {
        Row: Notification
        Insert: Partial<Notification>
        Update: Partial<Notification>
      }
      announcements: {
        Row: Announcement
        Insert: Partial<Announcement>
        Update: Partial<Announcement>
      }
      activity_log: {
        Row: ActivityLogEntry
        Insert: Partial<ActivityLogEntry>
        Update: Partial<ActivityLogEntry>
      }
      departments: { Row: Department; Insert: Partial<Department>; Update: Partial<Department> }
      audience_colors: {
        Row: AudienceColorRow
        Insert: Partial<AudienceColorRow>
        Update: Partial<AudienceColorRow>
      }
      courses: { Row: Course; Insert: Partial<Course>; Update: Partial<Course> }
      course_enrolments: {
        Row: CourseEnrolment
        Insert: Partial<CourseEnrolment>
        Update: Partial<CourseEnrolment>
      }
      learning_activity_logs: {
        Row: LearningActivityLog
        Insert: Partial<LearningActivityLog>
        Update: Partial<LearningActivityLog>
      }
      notification_settings: {
        Row: NotificationSettings
        Insert: Partial<NotificationSettings>
        Update: Partial<NotificationSettings>
      }
      email_notification_logs: {
        Row: EmailNotificationLog
        Insert: Partial<EmailNotificationLog>
        Update: Partial<EmailNotificationLog>
      }
      certificate_settings: {
        Row: CertificateSettingsRow
        Insert: Partial<CertificateSettingsRow>
        Update: Partial<CertificateSettingsRow>
      }
      training_kpi_targets: {
        Row: TrainingKpiTarget
        Insert: Partial<TrainingKpiTarget>
        Update: Partial<TrainingKpiTarget>
      }
      kpi_report_exports: {
        Row: KpiReportExport
        Insert: Partial<KpiReportExport>
        Update: Partial<KpiReportExport>
      }
      badge_criteria: {
        Row: BadgeCriterionRow
        Insert: Partial<BadgeCriterionRow>
        Update: Partial<BadgeCriterionRow>
      }
      issued_certificates: {
        Row: IssuedCertificateRow
        Insert: Partial<IssuedCertificateRow>
        Update: Partial<IssuedCertificateRow>
      }
      custom_badges: {
        Row: CustomBadgeRow
        Insert: Partial<CustomBadgeRow>
        Update: Partial<CustomBadgeRow>
      }
      employee_badge_awards: {
        Row: EmployeeBadgeAwardRow
        Insert: Partial<EmployeeBadgeAwardRow>
        Update: Partial<EmployeeBadgeAwardRow>
      }
    }
  }
}
