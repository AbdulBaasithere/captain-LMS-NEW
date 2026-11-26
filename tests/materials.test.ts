import assert from 'node:assert/strict'
import test from 'node:test'
import {
  applyUploadedVideoToModule,
  documentEmbedUrl,
  formatDuration,
  hasAnyVideo,
  inferDocumentType,
  inferVideoType,
  isMissingModuleColumnError,
  materialType,
} from '../src/lib/materialHelpers.ts'

test('inferVideoType recognizes supported video extensions and rejects unsupported files', () => {
  assert.equal(inferVideoType('lesson-intro.mp4'), 'mp4')
  assert.equal(inferVideoType('TRAINING.WEBM'), 'webm')
  assert.equal(inferVideoType('walkthrough.mov'), 'mov')
  assert.equal(inferVideoType('module.m4v'), 'm4v')
  assert.equal(inferVideoType('clip.ogg'), 'ogg')
  assert.equal(inferVideoType('slides.pdf'), null)
  assert.equal(inferVideoType('no-extension'), null)
})

test('inferDocumentType keeps existing document & presentation formats intact', () => {
  assert.equal(inferDocumentType('deck.pptx'), 'pptx')
  assert.equal(inferDocumentType('legacy.ppt'), 'ppt')
  assert.equal(inferDocumentType('guide.pdf'), 'pdf')
  assert.equal(inferDocumentType('sop.docx'), 'docx')
  assert.equal(inferDocumentType('video.mp4'), null)
})

test('hasAnyVideo detects YouTube, uploaded video, or both', () => {
  assert.equal(hasAnyVideo({ youtube_id: 'dQw4w9WgXcQ', video_url: null }), true)
  assert.equal(hasAnyVideo({ youtube_id: null, video_url: 'https://cdn.example/1/videos/intro.mp4' }), true)
  assert.equal(hasAnyVideo({ youtube_id: 'dQw4w9WgXcQ', video_url: 'https://cdn.example/intro.mp4' }), true)
  assert.equal(hasAnyVideo({ youtube_id: null, video_url: null }), false)
})

test('isMissingModuleColumnError catches PostgREST schema cache & missing column errors cleanly', () => {
  assert.equal(
    isMissingModuleColumnError("Could not find the 'video_type' column of 'modules' in the schema cache"),
    true,
  )
  assert.equal(
    isMissingModuleColumnError("Could not find the 'video_url' column of 'modules' in the schema cache"),
    true,
  )
  assert.equal(isMissingModuleColumnError('column "video_type" of relation "modules" does not exist'), true)
  assert.equal(isMissingModuleColumnError('new row violates row-level security policy'), false)
  assert.equal(isMissingModuleColumnError(null), false)
})

test('applyUploadedVideoToModule merges storage manifest entry cleanly when DB columns are absent', () => {
  const base = { id: 12, title: 'Intro', duration_seconds: 300, video_url: null, video_type: null }
  const hydrated = applyUploadedVideoToModule(base, {
    video_url: 'https://cdn.example/12/videos/intro.mp4',
    video_type: 'mp4',
    duration_seconds: 142,
    updated_at: '2026-11-13T00:00:00Z',
  })
  assert.equal(hydrated.video_url, 'https://cdn.example/12/videos/intro.mp4')
  assert.equal(hydrated.video_type, 'mp4')
  assert.equal(hydrated.duration_seconds, 142)

  // Already populated from DB keeps DB values
  const withDb = { id: 12, title: 'Intro', duration_seconds: 90, video_url: 'https://db.example/v.webm', video_type: null }
  const kept = applyUploadedVideoToModule(withDb, {
    video_url: 'https://fallback.example/v.mp4',
    video_type: 'mp4',
    updated_at: '2026-11-13T00:00:00Z',
  })
  assert.equal(kept.video_url, 'https://db.example/v.webm')
  assert.equal(kept.video_type, 'webm')
})

test('materialType formats all combinations of YouTube, uploaded video, and documents', () => {
  assert.equal(materialType({ youtube_id: 'abc12345678', video_url: null, document_type: null }), 'Video')
  assert.equal(materialType({ youtube_id: null, video_url: 'https://x/v.mp4', video_type: 'mp4', document_type: null }), 'Video')
  assert.equal(
    materialType({ youtube_id: 'abc12345678', video_url: 'https://x/v.mp4', video_type: 'mp4', document_type: null }),
    'YouTube + Uploaded Video',
  )
  assert.equal(
    materialType({ youtube_id: 'abc12345678', video_url: null, document_url: 'https://x/d.pdf', document_type: 'pdf' }),
    'Video + PDF',
  )
  assert.equal(
    materialType({ youtube_id: null, video_url: 'https://x/v.webm', video_type: 'webm', document_url: 'https://x/d.pptx', document_type: 'pptx' }),
    'Video + PPTX',
  )
  assert.equal(
    materialType({
      youtube_id: 'abc12345678',
      video_url: 'https://x/v.mp4',
      video_type: 'mp4',
      document_url: 'https://x/d.pptx',
      document_type: 'pptx',
    }),
    'YouTube + Uploaded Video + PPTX',
  )
  assert.equal(materialType({ youtube_id: null, video_url: null, document_url: 'https://x/d.pdf', document_type: 'pdf' }), 'PDF')
  assert.equal(materialType({ youtube_id: null, video_url: null, document_url: null, document_type: null }), 'None')
})

test('formatDuration handles uploaded videos alongside YouTube and documents', () => {
  assert.equal(formatDuration({ youtube_id: null, video_url: 'https://x/v.mp4', duration_seconds: 185 }), '3 min')
  assert.equal(formatDuration({ youtube_id: 'abc12345678', video_url: null, duration_seconds: 25 }), '<1 min')
  assert.equal(formatDuration({ youtube_id: null, video_url: null, document_type: 'pdf', duration_seconds: 300 }), 'Untimed')
  assert.equal(formatDuration({ youtube_id: null, video_url: null, document_type: null, duration_seconds: 300 }), '—')
})

test('documentEmbedUrl preserves PDF direct URL and wraps Office presentations/docs', () => {
  assert.equal(documentEmbedUrl('https://cdn.example/slides.pdf', 'pdf'), 'https://cdn.example/slides.pdf')
  assert.equal(
    documentEmbedUrl('https://cdn.example/slides.pptx', 'pptx'),
    'https://view.officeapps.live.com/op/embed.aspx?src=https%3A%2F%2Fcdn.example%2Fslides.pptx',
  )
})
