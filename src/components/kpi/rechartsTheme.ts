import React from 'react'

export const CHART_COLORS = {
  blue: '#2f5be8',
  teal: '#15803d',
  brass: '#f08a24',
  danger: '#c0392b',
  indigo: '#6d3fc0',
  slate: '#64748b',
} as const

export function h(
  type: unknown,
  props: Record<string, unknown> | null,
  ...children: React.ReactNode[]
): React.ReactElement {
  return React.createElement(type as React.ElementType, props, ...children)
}

export const AXIS_TICK_STYLE = {
  fill: 'var(--ink-soft)',
  fontSize: 11,
  fontFamily: "'IBM Plex Mono', 'Plus Jakarta Sans', sans-serif",
}

export const GRID_PROPS = {
  stroke: 'var(--border)',
  strokeDasharray: '3 3',
  vertical: false,
}

export const TOOLTIP_CONTENT_STYLE: React.CSSProperties = {
  backgroundColor: 'var(--surface)',
  border: '1px solid var(--border)',
  borderRadius: '10px',
  boxShadow: '0 8px 24px -8px rgba(15, 26, 46, 0.25)',
  color: 'var(--ink)',
  fontSize: '12.5px',
  fontFamily: "'Plus Jakarta Sans', sans-serif",
  padding: '8px 12px',
}

export const TOOLTIP_LABEL_STYLE: React.CSSProperties = {
  color: 'var(--ink)',
  fontWeight: 700,
  marginBottom: '4px',
}

export const TOOLTIP_ITEM_STYLE: React.CSSProperties = {
  color: 'var(--ink-soft)',
  padding: '2px 0',
  fontVariantNumeric: 'tabular-nums',
}

export const LEGEND_WRAPPER_STYLE: React.CSSProperties = {
  fontSize: '12px',
  color: 'var(--ink-soft)',
  paddingTop: '8px',
}

export function shortChartLabel(label: string, max = 14): string {
  const clean = label.trim()
  if (clean.length <= max) return clean
  return `${clean.slice(0, max - 1)}…`
}
