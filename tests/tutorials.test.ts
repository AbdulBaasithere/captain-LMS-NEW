import test from 'node:test'
import assert from 'node:assert/strict'
import {
  computeTutorialAnalytics,
  detectExternalVideoKind,
  enrichTutorials,
  filterTutorials,
  formatTutorialDuration,
  isTutorialVisibleToDepartment,
  parseInstructionBlocks,
  resolveTutorialThumbnail,
  sanitizeExternalUrl,
  slugifyCategoryName,
} from '../src/lib/tutorialHelpers'
import type { Profile, Tutorial, TutorialCategory, TutorialProgress } from '../src/lib/database.types'

function makeCategory(overrides: Partial<TutorialCategory> = {}): TutorialCategory {
  return {
    id: 1,
    name: 'Getting Started',
    slug: 'getting-started',
    description: 'Intro guides',
    color: '#dd3333',
    sort_order: 1,
    created_by: null,
    created_at: '2026-11-25T00:00:00.000Z',
    ...overrides,
  }
}

function makeTutorial(overrides: Partial<Tutorial> = {}): Tutorial {
  return {
    id: 10,
    title: 'Welcome Walkthrough',
    description: 'Learn the portal basics',
    instructions: '# Overview\n1. Sign in\n- Check your dashboard',
    category_id: 1,
    thumbnail_url: null,
    video_source: 'youtube',
    video_url: 'https://youtu.be/dQw4w9WgXcQ',
    youtube_id: 'dQw4w9WgXcQ',
    duration_seconds: 185,
    departments: ['General'],
    is_published: true,
    view_count: 12,
    created_by: null,
    created_at: '2026-11-25T00:00:00.000Z',
    updated_at: '2026-11-25T00:00:00.000Z',
    ...overrides,
  }
}

test('sanitizeExternalUrl accepts http/https URLs and blocks dangerous schemes', () => {
  assert.equal(sanitizeExternalUrl('https://example.com/video.mp4'), 'https://example.com/video.mp4')
  assert.equal(sanitizeExternalUrl('javascript:alert(1)'), null)
  assert.equal(sanitizeExternalUrl('data:text/html,<script>alert(1)</script>'), null)
  assert.equal(sanitizeExternalUrl('not-a-url'), null)
})

test('detectExternalVideoKind recognizes YouTube, Vimeo, Loom, and direct video files', () => {
  const yt = detectExternalVideoKind('https://www.youtube.com/watch?v=dQw4w9WgXcQ')
  assert.equal(yt.kind, 'youtube')
  if (yt.kind === 'youtube') {
    assert.equal(yt.youtubeId, 'dQw4w9WgXcQ')
    assert.match(yt.embedUrl, /youtube-nocookie\.com\/embed\/dQw4w9WgXcQ/)
  }

  const vimeo = detectExternalVideoKind('https://vimeo.com/123456789')
  assert.equal(vimeo.kind, 'vimeo')

  const loom = detectExternalVideoKind('https://www.loom.com/share/abc123def456')
  assert.equal(loom.kind, 'loom')

  const mp4 = detectExternalVideoKind('https://cdn.example.com/demo/intro.mp4')
  assert.equal(mp4.kind, 'direct_video')
})

test('resolveTutorialThumbnail uses custom URL first and falls back to YouTube thumbnail', () => {
  assert.equal(
    resolveTutorialThumbnail({ thumbnail_url: 'https://cdn.example.com/thumb.png', youtube_id: 'dQw4w9WgXcQ' }),
    'https://cdn.example.com/thumb.png',
  )
  assert.equal(
    resolveTutorialThumbnail({ thumbnail_url: null, youtube_id: 'dQw4w9WgXcQ' }),
    'https://i.ytimg.com/vi/dQw4w9WgXcQ/hqdefault.jpg',
  )
  assert.equal(resolveTutorialThumbnail({ thumbnail_url: 'javascript:evil()', youtube_id: null }), null)
})

test('isTutorialVisibleToDepartment matches General and assigned employee department cleanly', () => {
  assert.equal(isTutorialVisibleToDepartment(['General'], 'Engineering'), true)
  assert.equal(isTutorialVisibleToDepartment(['Sales', 'Marketing'], 'Sales'), true)
  assert.equal(isTutorialVisibleToDepartment(['Sales', 'Marketing'], 'Engineering'), false)
  assert.equal(isTutorialVisibleToDepartment(['engineering'], 'Engineering'), true)
})

test('filterTutorials supports real-time search, category, and progress status together', () => {
  const cats = [
    makeCategory({ id: 1, name: 'Getting Started' }),
    makeCategory({ id: 2, name: 'Safety', slug: 'safety' }),
  ]
  const tuts = [
    makeTutorial({ id: 1, title: 'Portal Tour', category_id: 1 }),
    makeTutorial({ id: 2, title: 'Fire Drill SOP', category_id: 2, instructions: 'Meet at north exit' }),
    makeTutorial({ id: 3, title: 'Expense Claims', category_id: 1 }),
  ]
  const progress: TutorialProgress[] = [
    {
      id: 1,
      tutorial_id: 1,
      user_id: 'u1',
      status: 'completed',
      watched_seconds: 180,
      progress_pct: 100,
      view_count: 2,
      last_viewed_at: '2026-11-25T01:00:00.000Z',
      completed_at: '2026-11-25T01:05:00.000Z',
      updated_at: '2026-11-25T01:05:00.000Z',
    },
    {
      id: 2,
      tutorial_id: 2,
      user_id: 'u1',
      status: 'in_progress',
      watched_seconds: 40,
      progress_pct: 35,
      view_count: 1,
      last_viewed_at: '2026-11-25T02:00:00.000Z',
      completed_at: null,
      updated_at: '2026-11-25T02:00:00.000Z',
    },
  ]

  const enriched = enrichTutorials(tuts, cats, progress)

  assert.deepEqual(
    filterTutorials(enriched, { search: 'north exit', categoryId: 'all', status: 'all' }).map((t) => t.id),
    [2],
  )
  assert.deepEqual(
    filterTutorials(enriched, { search: '', categoryId: 1, status: 'completed' }).map((t) => t.id),
    [1],
  )
  assert.deepEqual(
    filterTutorials(enriched, { search: '', categoryId: 1, status: 'not_started' }).map((t) => t.id),
    [3],
  )
})

test('parseInstructionBlocks safely extracts headings, numbered steps, bullets, and paragraphs', () => {
  const blocks = parseInstructionBlocks('# Step Guide\n1. Open portal\n- Bring checklist\nDone!')
  assert.deepEqual(blocks, [
    { type: 'heading', text: 'Step Guide' },
    { type: 'ordered', orderNumber: 1, text: 'Open portal' },
    { type: 'bullet', text: 'Bring checklist' },
    { type: 'paragraph', text: 'Done!' },
  ])
})

test('computeTutorialAnalytics aggregates views, viewers, completions, and completion rate', () => {
  const cats = [makeCategory({ id: 1, name: 'Getting Started' })]
  const tuts = [makeTutorial({ id: 1, view_count: 5, departments: ['Sales'] })]
  const profiles: Pick<Profile, 'id' | 'department' | 'role' | 'is_active'>[] = [
    { id: 'e1', department: 'Sales', role: 'employee', is_active: true },
    { id: 'e2', department: 'Sales', role: 'employee', is_active: true },
    { id: 'e3', department: 'Engineering', role: 'employee', is_active: true },
  ]
  const progress: TutorialProgress[] = [
    {
      id: 1,
      tutorial_id: 1,
      user_id: 'e1',
      status: 'completed',
      watched_seconds: 185,
      progress_pct: 100,
      view_count: 4,
      last_viewed_at: '2026-11-25T01:00:00.000Z',
      completed_at: '2026-11-25T01:05:00.000Z',
      updated_at: '2026-11-25T01:05:00.000Z',
    },
    {
      id: 2,
      tutorial_id: 1,
      user_id: 'e2',
      status: 'in_progress',
      watched_seconds: 60,
      progress_pct: 32,
      view_count: 2,
      last_viewed_at: '2026-11-25T02:00:00.000Z',
      completed_at: null,
      updated_at: '2026-11-25T02:00:00.000Z',
    },
  ]

  const summary = computeTutorialAnalytics(tuts, cats, progress, profiles)
  assert.equal(summary.publishedCount, 1)
  assert.equal(summary.totalViews, 6)
  assert.equal(summary.totalCompletions, 1)
  assert.equal(summary.rows[0]?.uniqueViewers, 2)
  assert.equal(summary.rows[0]?.inProgressCount, 1)
  assert.equal(summary.rows[0]?.completionRatePct, 50)
})

test('formatTutorialDuration and slugifyCategoryName format cleanly', () => {
  assert.equal(formatTutorialDuration(185), '3:05')
  assert.equal(formatTutorialDuration(3661), '1:01:01')
  assert.equal(slugifyCategoryName('Workflows & SOPs!'), 'workflows-sops')
})
