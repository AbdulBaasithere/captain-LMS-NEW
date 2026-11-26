import { computed, ref } from 'vue'
import { supabase } from '@/lib/supabase'
import type { Tutorial } from '@/lib/database.types'

export type TourRole = 'employee' | 'admin'

export interface TourStep {
  id: string
  route: string
  icon: string
  title: string
  subtitle: string
  tutorialTitle: string
  components: { name: string; detail: string }[]
  howTo: string[]
}

const EMPLOYEE_STEPS: TourStep[] = [
  {
    id: 'emp-dashboard',
    route: '/app/dashboard',
    icon: '▦',
    title: 'Welcome to Your Employee Dashboard',
    subtitle: 'Your daily command center for active courses, quiz alerts, and weekly study goals.',
    tutorialTitle: 'Employee Dashboard & Navigation',
    components: [
      { name: 'Quiz Ready Banner', detail: 'Alerts you immediately when a Milestone Quiz is unlocked.' },
      { name: 'KPI Summary & Charts', detail: 'Tracks completion rate, average quiz score, and monthly study hours.' },
      { name: 'Hero Continue Card', detail: 'Resumes your latest course or launches a Practice Quiz in one click.' },
      { name: 'My Courses Grid', detail: 'Shows course progress bars and quick PDF certificate downloads.' },
      { name: 'Weekly Goal & Notifications', detail: 'Monitors your weekly target and alerts you about deadlines.' },
    ],
    howTo: [
      'Check the top banner for any unlocked Milestone Quiz.',
      'Click Continue on the Hero card to jump straight into your active lesson.',
      'Use the left sidebar (or bottom bar on mobile) to switch sections anytime.',
    ],
  },
  {
    id: 'emp-catalog',
    route: '/app/catalog',
    icon: '▤',
    title: 'Browse & Apply for Courses',
    subtitle: 'Discover company-wide and department-specific training in the Course Catalog.',
    tutorialTitle: 'How to Browse & Apply for Courses (Course Catalog)',
    components: [
      { name: 'Search Bar', detail: 'Filters courses in real time by title, topic, or description.' },
      { name: 'Difficulty & Category Filters', detail: 'Narrows courses by skill level and topic.' },
      { name: 'Course Cards', detail: 'Shows lesson count, estimated duration, and department eligibility.' },
      { name: 'Enroll / Apply Button', detail: 'Adds the course to your personal track in My Learning.' },
    ],
    howTo: [
      'Search by keyword or filter by difficulty/category.',
      'Review a course card for duration and lesson count.',
      'Click Enroll / Apply (or Open course) to start learning.',
    ],
  },
  {
    id: 'emp-learning',
    route: '/app/modules',
    icon: '▶',
    title: 'Learn & Use the Lesson Player',
    subtitle: 'Watch lesson videos, read attached PDFs, take practice quizzes, and mark lessons complete.',
    tutorialTitle: 'How to Learn & Use the Lesson Player',
    components: [
      { name: 'My Learning List', detail: 'Displays all enrolled modules with completion percentages.' },
      { name: 'Lesson Player', detail: 'Plays uploaded/external videos alongside PDFs and written materials.' },
      { name: 'Practice Quiz', detail: 'Lets you test your knowledge before taking official milestone quizzes.' },
      { name: 'Mark Complete Button', detail: 'Saves lesson progress and updates your weekly goal & streak.' },
    ],
    howTo: [
      'Open any module from My Learning to launch the Lesson Player.',
      'Watch the video or read the attached lesson materials.',
      'Click Mark Complete when finished to advance your course progress.',
    ],
  },
  {
    id: 'emp-tutorials',
    route: '/app/tutorials',
    icon: '🎬',
    title: 'Captain Academy – Tutorials & Guides',
    subtitle: 'Watch bite-sized video demos and step-by-step written guides for every LMS feature.',
    tutorialTitle: 'Using Captain Academy Tutorials & Guides',
    components: [
      { name: 'Progress Summary', detail: 'Shows total, In Progress, and Completed tutorials.' },
      { name: 'Search, Category & Status Filters', detail: 'Filter by Not Started, In Progress, or Completed.' },
      { name: 'Dedicated Tutorial Player', detail: 'Pairs the demo video with formatted step-by-step instructions.' },
    ],
    howTo: [
      'Search or pick a category chip to find a walkthrough.',
      'Click any tutorial card to watch the video and read the written steps.',
      'Click Mark as Completed when you finish watching.',
    ],
  },
  {
    id: 'emp-badges',
    route: '/app/badges',
    icon: '🏆',
    title: 'Earn Badges, Quizzes & Certificates',
    subtitle: 'Unlock achievement badges, pass milestone quizzes, and download official PDF certificates.',
    tutorialTitle: 'How to Earn Badges, Milestone Quizzes & Certificates',
    components: [
      { name: 'Milestone & Achievement Badges', detail: 'Earned from completed study hours, courses, and certificates.' },
      { name: 'Course Completion Certificates', detail: 'Unlocked automatically at 100% course completion with PDF download.' },
      { name: 'Milestone Quiz Badges', detail: 'Unlocked by finishing track lessons and passing the milestone quiz.' },
    ],
    howTo: [
      'Complete 100% of lessons in any course to unlock its PDF Certificate.',
      'When a Milestone Quiz shows ready, click it and pass above the threshold.',
      'Click any earned certificate to preview or download the official PDF.',
    ],
  },
  {
    id: 'emp-calendar',
    route: '/app/calendar',
    icon: '📅',
    title: 'Track Deadlines & Schedule',
    subtitle: 'Stay ahead of upcoming course due dates and compliance deadlines.',
    tutorialTitle: 'How to Earn Badges, Milestone Quizzes & Certificates',
    components: [
      { name: 'Deadlines Calendar', detail: 'Lists upcoming and overdue course due dates chronologically.' },
      { name: 'Status Indicators', detail: 'Highlights completed, due-soon, and overdue training items.' },
    ],
    howTo: [
      'Open Deadlines from the sidebar to check upcoming due dates.',
      'Click any due course to jump directly to its lessons.',
    ],
  },
  {
    id: 'emp-account',
    route: '/app/account',
    icon: '⚙',
    title: 'Account, Theme & Replaying This Demo',
    subtitle: 'Check your department profile, switch themes, and replay this guided tour anytime.',
    tutorialTitle: 'Managing Your Employee Account & Workspace Tips',
    components: [
      { name: 'Profile & Department', detail: 'Shows your name and department (controls course & tutorial visibility).' },
      { name: 'Theme Toggle', detail: 'Switches Captain LMS between Light and Dark mode.' },
      { name: 'Replay Demo Button', detail: 'Re-opens this interactive tour and demo videos whenever you need a refresher.' },
    ],
    howTo: [
      'Verify your department in Account so you receive the right training.',
      'Click "Show Walkthrough & Demo Again" in Account anytime to replay this tour.',
    ],
  },
]

const ADMIN_STEPS: TourStep[] = [
  {
    id: 'admin-overview',
    route: '/admin/overview',
    icon: '▦',
    title: 'Admin Analytics Overview',
    subtitle: 'Monitor organization-wide completion rates, active learners, and quiz performance.',
    tutorialTitle: 'Admin: Analytics Overview',
    components: [
      { name: 'KPI Summary Strip', detail: 'Tracks total learners, overall completion, and active trends.' },
      { name: 'Quiz & Compliance Charts', detail: 'Visualizes quiz pass rates and department compliance.' },
    ],
    howTo: [
      'Review top KPIs upon signing in to /admin/overview.',
      'Scroll to inspect quiz performance and department compliance charts.',
    ],
  },
  {
    id: 'admin-employees',
    route: '/admin/employees',
    icon: '👥',
    title: 'Employees & Department Audiences',
    subtitle: 'Manage learner profiles, inspect individual progress, and customize audience colors.',
    tutorialTitle: 'Admin: Managing Employees & Audiences',
    components: [
      { name: 'Employees Directory', detail: 'Search learners, invite new staff, and drill into individual progress.' },
      { name: 'Audiences', detail: 'Define departments and custom color badges used for course/tutorial targeting.' },
    ],
    howTo: [
      'Use Employees to review individual learner progress or invite new team members.',
      'Use Audiences to manage department names and badge colors.',
    ],
  },
  {
    id: 'admin-courses',
    route: '/admin/courses',
    icon: '🎓',
    title: 'Courses & Lesson Modules',
    subtitle: 'Build structured courses, assign target departments, and upload lesson videos or quizzes.',
    tutorialTitle: 'Admin: Courses & Lesson Modules',
    components: [
      { name: 'Courses', detail: 'Create/edit courses, set difficulty, and assign department visibility.' },
      { name: 'Modules (Lessons)', detail: 'Upload lesson videos, attach PDFs, and configure quiz questions.' },
    ],
    howTo: [
      'Create a course in Courses and assign target departments.',
      'Add lessons and materials in Modules (lessons) before publishing.',
    ],
  },
  {
    id: 'admin-tutorials',
    route: '/admin/tutorials',
    icon: '🎬',
    title: 'Managing Captain Academy Tutorials',
    subtitle: 'Upload tutorial videos or external URLs, organize categories, and track views & completions.',
    tutorialTitle: 'Admin: Managing Academy Tutorials',
    components: [
      { name: 'Tutorials Tab', detail: 'Add, edit, delete, publish/unpublish tutorials, and set department visibility.' },
      { name: 'Categories Tab', detail: 'Create and reorder color-coded tutorial categories.' },
      { name: 'Analytics Tab', detail: 'Monitor views, unique viewers, completions, and per-employee drilldowns.' },
    ],
    howTo: [
      'Click + New Tutorial to upload a video or paste a YouTube/Vimeo/Loom URL.',
      'Use Categories and Analytics tabs to organize content and track engagement.',
    ],
  },
  {
    id: 'admin-settings',
    route: '/admin/dashboard-settings',
    icon: '⚙',
    title: 'Monitoring, Certificates & Settings',
    subtitle: 'Configure alerts, PDF certificate templates, badge criteria, and replay this tour anytime.',
    tutorialTitle: 'Admin: Monitoring, Certificates & Settings',
    components: [
      { name: 'Monitoring & Alerts', detail: 'Track overdue learners and automated notification rules.' },
      { name: 'Certificates & Badges', detail: 'Customize PDF certificate alignment and milestone badge criteria.' },
      { name: 'Dashboard Settings', detail: 'Toggle visible employee widgets and replay this Admin guided tour.' },
    ],
    howTo: [
      'Toggle optional employee sidebar sections in Dashboard Settings.',
      'Click "Show Admin Demo Tour Again" in Dashboard Settings anytime to replay.',
    ],
  },
]

const isOpen = ref(false)
const activeRole = ref<TourRole>('employee')
const stepIndex = ref(0)
const tutorialsCache = ref<Tutorial[]>([])
const tutorialsLoaded = ref(false)

function storageKey(role: TourRole, userId?: string | null): string {
  return `captain_lms_tour_seen_${role}_${userId || 'anon'}`
}

async function ensureTutorialsLoaded() {
  if (tutorialsLoaded.value) return
  try {
    const { data } = await supabase
      .from('tutorials')
      .select('*')
      .eq('is_published', true)
      .order('id', { ascending: true })
    tutorialsCache.value = (data ?? []) as Tutorial[]
  } catch {
    tutorialsCache.value = []
  } finally {
    tutorialsLoaded.value = true
  }
}

export function useOnboardingTour() {
  const steps = computed(() => (activeRole.value === 'admin' ? ADMIN_STEPS : EMPLOYEE_STEPS))
  const currentStep = computed(() => steps.value[stepIndex.value] ?? steps.value[0]!)
  const matchedTutorial = computed(() => {
    const step = currentStep.value
    if (!step) return null
    return (
      tutorialsCache.value.find((t) => t.title === step.tutorialTitle) ??
      tutorialsCache.value.find((t) => t.title.toLowerCase().includes(step.title.toLowerCase())) ??
      null
    )
  })

  function maybeStartFirstLoginTour(role: TourRole, userId?: string | null) {
    if (!userId) return
    try {
      if (localStorage.getItem(storageKey(role, userId))) return
      // Mark as seen immediately so the tour never auto-opens again,
      // even if the user closes the tab, navigates away, or skips mid-tour.
      localStorage.setItem(storageKey(role, userId), '1')
    } catch {
      return
    }
    activeRole.value = role
    stepIndex.value = 0
    isOpen.value = true
    void ensureTutorialsLoaded()
  }

  function replayTour(role: TourRole) {
    activeRole.value = role
    stepIndex.value = 0
    isOpen.value = true
    void ensureTutorialsLoaded()
  }

  function markSeenAndClose(_userId?: string | null) {
    // localStorage is already written at tour-open time for the auto-tour path.
    // This function just closes the modal (also used by replayTour).
    isOpen.value = false
  }

  function goToStep(idx: number) {
    if (idx >= 0 && idx < steps.value.length) {
      stepIndex.value = idx
    }
  }

  return {
    isOpen,
    activeRole,
    stepIndex,
    steps,
    currentStep,
    matchedTutorial,
    maybeStartFirstLoginTour,
    replayTour,
    markSeenAndClose,
    goToStep,
  }
}
