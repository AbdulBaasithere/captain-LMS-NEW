import test from 'node:test'
import assert from 'node:assert/strict'
import { filterCatalogCourses, resolveCourseDifficulty } from '../src/lib/courseFilters.ts'
import type { CourseDifficulty, Module } from '../src/lib/database.types.ts'

function makeModule(id: number, quizRequired = false): Module {
  return {
    id,
    title: `Lesson ${id}`,
    department: 'General',
    youtube_id: null,
    document_url: null,
    document_type: null,
    quiz_required: quizRequired,
    duration_seconds: 300,
    is_draft: false,
    scheduled_date: null,
    is_archived: false,
    created_by: null,
    created_at: '2026-11-01T00:00:00Z',
  }
}

const SAMPLE_COURSES = [
  {
    id: '1',
    title: 'Workplace Safety Essentials',
    category: 'General',
    difficulty: 'Beginner' as CourseDifficulty,
    description: 'Core onboarding safety handbook.',
    progress: { status: 'completed' as const },
  },
  {
    id: '2',
    title: 'Odoo Sales Order Workflow',
    category: 'Sales',
    difficulty: 'Intermediate' as CourseDifficulty,
    description: 'Quotations, invoicing and approvals.',
    progress: { status: 'in-progress' as const },
  },
  {
    id: '3',
    title: 'Security Architecture & Audit',
    category: 'Engineering',
    difficulty: 'Advanced' as CourseDifficulty,
    description: 'Deep dive into zero-trust controls.',
    progress: { status: 'not-started' as const },
  },
]

test('1. Resolves explicit difficulty or infers accurately from course content', () => {
  assert.equal(resolveCourseDifficulty('Advanced', 'Intro Course', null, [makeModule(1)]), 'Advanced')
  assert.equal(resolveCourseDifficulty(null, 'New Hire Onboarding', null, [makeModule(1)]), 'Beginner')
  assert.equal(
    resolveCourseDifficulty(null, 'Warehouse Operations', null, [makeModule(1), makeModule(2), makeModule(3)]),
    'Intermediate',
  )
  assert.equal(resolveCourseDifficulty(null, 'System Architecture Deep Dive', null, [makeModule(1)]), 'Advanced')
})

test('2. Real-time search matches title, category, difficulty, and description', () => {
  assert.equal(filterCatalogCourses(SAMPLE_COURSES, { search: 'odoo', category: 'All', difficulty: 'All' }).length, 1)
  assert.equal(
    filterCatalogCourses(SAMPLE_COURSES, { search: 'engineering', category: 'All', difficulty: 'All' })[0]?.id,
    '3',
  )
  assert.equal(
    filterCatalogCourses(SAMPLE_COURSES, { search: 'advanced', category: 'All', difficulty: 'All' })[0]?.id,
    '3',
  )
  assert.equal(
    filterCatalogCourses(SAMPLE_COURSES, { search: 'invoicing', category: 'All', difficulty: 'All' })[0]?.id,
    '2',
  )
})

test('3. Filters cleanly by category, difficulty level, and completion status combined', () => {
  const byDiff = filterCatalogCourses(SAMPLE_COURSES, {
    search: '',
    category: 'All',
    difficulty: 'Intermediate',
  })
  assert.deepEqual(
    byDiff.map((c) => c.id),
    ['2'],
  )

  const byCatAndStatus = filterCatalogCourses(SAMPLE_COURSES, {
    search: '',
    category: 'General',
    difficulty: 'All',
    status: 'Completed',
  })
  assert.deepEqual(
    byCatAndStatus.map((c) => c.id),
    ['1'],
  )

  const noMatch = filterCatalogCourses(SAMPLE_COURSES, {
    search: '',
    category: 'Sales',
    difficulty: 'Advanced',
  })
  assert.equal(noMatch.length, 0)
})
