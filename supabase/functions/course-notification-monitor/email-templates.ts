import type { NotificationType } from './monitor-logic.ts'

export interface EmailTemplateContext {
  notificationType: NotificationType
  employeeName: string
  department: string
  courseName: string
  courseCategory?: string
  progressPct: number
  lastActivityIso: string | null
  deadlineDate: string | null
  courseUrl: string
  organizationName?: string
  daysInactive?: number
  daysRemaining?: number
  daysOverdue?: number
}

export interface RenderedEmail {
  subject: string
  html: string
  text: string
}

function escapeHtml(raw: string): string {
  return raw
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}

function formatReadableDate(isoOrDate: string | null): string {
  if (!isoOrDate) return 'No activity recorded yet'
  const d = new Date(isoOrDate.length === 10 ? `${isoOrDate}T00:00:00Z` : isoOrDate)
  if (Number.isNaN(d.getTime())) return isoOrDate
  return d.toLocaleDateString('en-US', {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
    timeZone: 'UTC',
  })
}

function formatLastActivity(iso: string | null): string {
  if (!iso) return 'Not started yet'
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return iso
  return d.toLocaleString('en-US', {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    timeZone: 'UTC',
    timeZoneName: 'short',
  })
}

export function renderCourseNotificationEmail(ctx: EmailTemplateContext): RenderedEmail {
  const org = ctx.organizationName || 'Captain LMS'
  const firstName = ctx.employeeName.split(' ')[0] || ctx.employeeName
  const progress = Math.max(0, Math.min(100, Math.round(ctx.progressPct)))
  const lastActivityStr = formatLastActivity(ctx.lastActivityIso)
  const deadlineStr = ctx.deadlineDate ? formatReadableDate(ctx.deadlineDate) : 'No deadline assigned'

  let badgeLabel = 'COURSE UPDATE'
  let badgeBg = '#e0e7ff'
  let badgeColor = '#1e3a8a'
  let accentColor = '#2f5be8'
  let headline = `Course Update: ${ctx.courseName}`
  let subject = `[${org}] ${ctx.courseName} — Training Update`
  let bodyParagraph = ''
  let ctaLabel = 'Continue Course in LMS'

  switch (ctx.notificationType) {
    case 'course_start': {
      badgeLabel = 'COURSE STARTED'
      badgeBg = '#dcfce7'
      badgeColor = '#166534'
      accentColor = '#0f7f6c'
      subject = `[${org}] ${ctx.employeeName} started "${ctx.courseName}"`
      headline = `Welcome to ${ctx.courseName}`
      bodyParagraph = `Hi ${escapeHtml(firstName)}, this confirms you have started your first lesson in <strong>${escapeHtml(ctx.courseName)}</strong>. Your reporting manager and HR representative have been copied on this confirmation so everyone is aligned on your onboarding and compliance progress.`
      ctaLabel = 'Resume Your Lesson'
      break
    }

    case 'inactivity_7d': {
      const days = ctx.daysInactive ?? 7
      badgeLabel = `${days}-DAY INACTIVITY REMINDER`
      badgeBg = '#fef3c7'
      badgeColor = '#92400e'
      accentColor = '#b4530f'
      subject = `[${org}] Reminder: ${days} days since last activity in "${ctx.courseName}"`
      headline = 'Resume your assigned training'
      bodyParagraph = `Hi ${escapeHtml(firstName)}, we noticed you haven't had any recorded learning activity in <strong>${escapeHtml(ctx.courseName)}</strong> for <strong>${days} consecutive days</strong>. Please jump back into the LMS at your earliest convenience to stay on schedule.`
      ctaLabel = 'Resume Training Now'
      break
    }

    case 'deadline_reminder': {
      const rem = ctx.daysRemaining ?? 3
      const urgent = rem <= 1
      badgeLabel = rem === 1 ? 'FINAL REMINDER · 1 DAY LEFT' : rem === 3 ? '3-DAY REMINDER' : `DUE IN ${rem} DAYS`
      badgeBg = urgent ? '#fee2e2' : '#fef3c7'
      badgeColor = urgent ? '#991b1b' : '#92400e'
      accentColor = urgent ? '#dc2626' : '#b4530f'
      subject =
        rem === 1
          ? `[${org}] FINAL REMINDER: "${ctx.courseName}" is due tomorrow`
          : rem === 3
            ? `[${org}] Reminder: 3 days left to complete "${ctx.courseName}"`
            : `[${org}] Deadline in ${rem} days — "${ctx.courseName}"`
      headline =
        rem === 1
          ? `Final Reminder: ${ctx.courseName} is due tomorrow`
          : rem === 3
            ? `3-Day Reminder: Please complete ${ctx.courseName}`
            : `Upcoming Deadline: ${rem} days left for ${ctx.courseName}`
      bodyParagraph =
        rem === 1
          ? `Hi ${escapeHtml(firstName)}, this is your <strong>final reminder</strong> that your assigned completion deadline for <strong>${escapeHtml(ctx.courseName)}</strong> is tomorrow (<strong>${escapeHtml(deadlineStr)}</strong>). You are currently at <strong>${progress}%</strong> completion. Completing the course stops all further reminders automatically.`
          : `Hi ${escapeHtml(firstName)}, this is a reminder that your assigned completion deadline for <strong>${escapeHtml(ctx.courseName)}</strong> is in <strong>${rem} days</strong> (${escapeHtml(deadlineStr)}). You are currently at <strong>${progress}%</strong> completion.`
      ctaLabel = rem === 1 ? 'Complete Course Today' : 'Complete Course Before Deadline'
      break
    }

    case 'course_overdue': {
      const overdueDays = ctx.daysOverdue ?? 1
      badgeLabel = `OVERDUE BY ${overdueDays} DAY${overdueDays === 1 ? '' : 'S'}`
      badgeBg = '#fee2e2'
      badgeColor = '#991b1b'
      accentColor = '#b91c1c'
      subject = `[${org}] OVERDUE: "${ctx.courseName}" — ${ctx.employeeName}`
      headline = `Overdue Training Alert: ${ctx.courseName}`
      bodyParagraph = `Hi ${escapeHtml(firstName)}, the assigned completion deadline (${escapeHtml(deadlineStr)}) for <strong>${escapeHtml(ctx.courseName)}</strong> has passed by <strong>${overdueDays} day${overdueDays === 1 ? '' : 's'}</strong>. Your HR representative and reporting manager are copied on this notice. Please complete all remaining lessons immediately.`
      ctaLabel = 'Complete Overdue Course'
      break
    }

    case 'manual_test': {
      badgeLabel = 'SYSTEM TEST NOTIFICATION'
      badgeBg = '#e0f2fe'
      badgeColor = '#075985'
      accentColor = '#0284c7'
      subject = `[${org}] Course Monitoring & Email Integration Test`
      headline = 'Email Notification Delivery Verified'
      bodyParagraph = `Hi ${escapeHtml(firstName)}, this is a live verification email from the <strong>${escapeHtml(org)}</strong> Automated Course Monitoring System confirming that your authorized email provider, HTML templates, and HR/Manager CC routing are functioning properly.`
      ctaLabel = 'Open Captain LMS'
      break
    }
  }

  const html = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>${escapeHtml(subject)}</title>
</head>
<body style="margin:0;padding:0;background-color:#f4f5f7;font-family:'Segoe UI',Roboto,'Helvetica Neue',Arial,sans-serif;color:#111827;">
  <table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" style="background-color:#f4f5f7;padding:32px 16px;">
    <tr>
      <td align="center">
        <table role="presentation" width="600" cellspacing="0" cellpadding="0" border="0" style="max-width:600px;width:100%;background-color:#ffffff;border-radius:14px;overflow:hidden;border:1px solid #e5e7eb;box-shadow:0 4px 16px rgba(15,23,42,0.06);">
          <!-- Header -->
          <tr>
            <td style="background-color:#0f172a;padding:24px 28px;border-bottom:4px solid ${accentColor};">
              <table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0">
                <tr>
                  <td>
                    <span style="display:inline-block;background-color:${accentColor};color:#ffffff;font-weight:800;font-size:14px;width:28px;height:28px;line-height:28px;text-align:center;border-radius:7px;vertical-align:middle;margin-right:10px;">C</span>
                    <span style="color:#ffffff;font-weight:700;font-size:17px;vertical-align:middle;">${escapeHtml(org)}</span>
                  </td>
                  <td align="right">
                    <span style="display:inline-block;background-color:${badgeBg};color:${badgeColor};font-size:11px;font-weight:700;letter-spacing:0.06em;padding:5px 10px;border-radius:999px;">
                      ${escapeHtml(badgeLabel)}
                    </span>
                  </td>
                </tr>
              </table>
            </td>
          </tr>

          <!-- Main Body -->
          <tr>
            <td style="padding:28px;">
              <h1 style="margin:0 0 12px 0;font-size:21px;line-height:1.3;color:#0f172a;font-weight:700;">
                ${escapeHtml(headline)}
              </h1>
              <p style="margin:0 0 22px 0;font-size:15px;line-height:1.6;color:#374151;">
                ${bodyParagraph}
              </p>

              <!-- Summary Card -->
              <table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" style="background-color:#f8fafc;border:1px solid #e2e8f0;border-radius:10px;margin-bottom:24px;">
                <tr>
                  <td style="padding:18px 20px;">
                    <table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" style="font-size:13.5px;color:#334155;">
                      <tr>
                        <td style="padding:5px 0;color:#64748b;width:140px;">Employee</td>
                        <td style="padding:5px 0;font-weight:600;color:#0f172a;">${escapeHtml(ctx.employeeName)} (${escapeHtml(ctx.department)})</td>
                      </tr>
                      <tr>
                        <td style="padding:5px 0;color:#64748b;">Assigned Course</td>
                        <td style="padding:5px 0;font-weight:600;color:#0f172a;">${escapeHtml(ctx.courseName)}</td>
                      </tr>
                      <tr>
                        <td style="padding:5px 0;color:#64748b;">Progress</td>
                        <td style="padding:5px 0;font-weight:700;color:${accentColor};">
                          ${progress}% completed
                          <div style="margin-top:6px;width:100%;height:8px;background-color:#e2e8f0;border-radius:999px;overflow:hidden;">
                            <div style="width:${progress}%;height:8px;background-color:${accentColor};border-radius:999px;"></div>
                          </div>
                        </td>
                      </tr>
                      <tr>
                        <td style="padding:5px 0;color:#64748b;">Last Activity</td>
                        <td style="padding:5px 0;font-weight:500;color:#0f172a;">${escapeHtml(lastActivityStr)}</td>
                      </tr>
                      <tr>
                        <td style="padding:5px 0;color:#64748b;">Deadline</td>
                        <td style="padding:5px 0;font-weight:600;color:${ctx.notificationType === 'course_overdue' ? '#b91c1c' : '#0f172a'};">${escapeHtml(deadlineStr)}</td>
                      </tr>
                    </table>
                  </td>
                </tr>
              </table>

              <!-- CTA Button -->
              <table role="presentation" cellspacing="0" cellpadding="0" border="0">
                <tr>
                  <td style="border-radius:9px;background-color:${accentColor};">
                    <a href="${escapeHtml(ctx.courseUrl)}" target="_blank" style="display:inline-block;padding:13px 24px;font-size:14.5px;font-weight:700;color:#ffffff;text-decoration:none;border-radius:9px;">
                      ${escapeHtml(ctaLabel)} &rarr;
                    </a>
                  </td>
                </tr>
              </table>

              <p style="margin:20px 0 0 0;font-size:12.5px;color:#64748b;line-height:1.5;">
                Direct link: <a href="${escapeHtml(ctx.courseUrl)}" style="color:${accentColor};word-break:break-all;">${escapeHtml(ctx.courseUrl)}</a>
              </p>
            </td>
          </tr>

          <!-- Footer -->
          <tr>
            <td style="background-color:#f8fafc;padding:16px 28px;border-top:1px solid #e5e7eb;font-size:12px;color:#64748b;line-height:1.5;">
              This automated message was sent by <strong>${escapeHtml(org)}</strong>. Reminders automatically stop as soon as you reach 100% course completion.
            </td>
          </tr>
        </table>
      </td>
    </tr>
  </table>
</body>
</html>`

  const text = [
    `${headline}`,
    '',
    `Employee: ${ctx.employeeName} (${ctx.department})`,
    `Course: ${ctx.courseName}`,
    `Progress: ${progress}%`,
    `Last Activity: ${lastActivityStr}`,
    `Deadline: ${deadlineStr}`,
    '',
    `Open Course: ${ctx.courseUrl}`,
  ].join('\n')

  return { subject, html, text }
}
