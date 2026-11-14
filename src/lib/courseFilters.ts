import type { CourseDifficulty, Module } from './database.types.ts'

export const COURSE_DIFFICULTIES: CourseDifficulty[] = ['Beginner', 'Intermediate', 'Advanced']

export function normalizeDifficulty(raw: string | null | undefined): CourseDifficulty | null {
  if (!raw) return null
  const val = raw.trim().toLowerCase()
  if (val === 'beginner') return 'Beginner'
  if (val === 'intermediate') return 'Intermediate'
  if (val === 'advanced') return 'Advanced'
  return null
}

/**
 * Resolves the course difficulty: uses explicit DB column if set, otherwise infers a sensible
 * default from title/description cues or lesson count & quiz requirements.
 */
export function resolveCourseDifficulty(
  explicit: string | null | undefined,
  title: string,
  description: string | null,
  lessons: Module[],
): CourseDifficulty {
  const normalized = normalizeDifficulty(explicit)
  if (normalized) return normalized

  const text = `${title} ${description ?? ''}`.toLowerCase()
  if (/\b(advanced|expert|master|architecture|audit|executive|deep dive)\b/.test(text)) {
    return 'Advanced'
  }
  if (/\b(intermediate|workflow|operations|management|compliance|assessment)\b/.test(text)) {
    return 'Intermediate'
  }
  if (lessons.length >= 6 || lessons.filter((l) => l.quiz_required).length >= 3) {
    return 'Advanced'
  }
  if (lessons.length >= 3 || lessons.some((l) => l.quiz_required)) {
    return 'Intermediate'
  }
  return 'Beginner'
}

export interface CatalogFilterCriteria {
  search: string
  category: string
  difficulty: 'All' | CourseDifficulty
  status?: 'All' | 'In progress' | 'Completed' | 'Not started'
}

export function filterCatalogCourses<
  T extends {
    title: string
    category: string
    difficulty: CourseDifficulty
    description?: string | null
    progress: { status: 'not-started' | 'in-progress' | 'completed' }
  },
>(items: T[], criteria: CatalogFilterCriteria): T[] {
  const q = criteria.search.trim().toLowerCase()
  const statusChoice = criteria.status ?? 'All'

  return items.filter((c) => {
    const matchesCategory = criteria.category === 'All' || c.category === criteria.category
    const matchesDifficulty = criteria.difficulty === 'All' || c.difficulty === criteria.difficulty
    const matchesStatus =
      statusChoice === 'All' ||
      (statusChoice === 'In progress' && c.progress.status === 'in-progress') ||
      (statusChoice === 'Completed' && c.progress.status === 'completed') ||
      (statusChoice === 'Not started' && c.progress.status === 'not-started')

    const searchable = `${c.title} ${c.category} ${c.difficulty} ${c.description ?? ''}`.toLowerCase()
    const matchesSearch = !q || searchable.includes(q)

    return matchesCategory && matchesDifficulty && matchesStatus && matchesSearch
  })
}
