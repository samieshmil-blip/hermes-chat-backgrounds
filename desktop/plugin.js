/**
 * Chat Backgrounds — per-chat colouring of the transcript surface.
 *
 * What it does
 *  · tints each chat surface with THAT session's own colour (the colour the
 *    sidebar dot already shows), so two chats in one window read apart at a
 *    glance;
 *  · adds a thin rail in the session colour along the left edge of the chat
 *    you are working in (core marks the NOT-focused surfaces, so the rail
 *    switches with no listener of ours);
 *  · picks the colour anywhere in the palette — the app's swatch grid, the
 *    native colour picker, or a typed hex — always through
 *    `host.sessions.setColor`, the same value the sidebar's colour menu writes;
 *  · keeps the text readable: for every painted surface it measures the real
 *    contrast (surface background against the theme's ink) and thins the fill
 *    until the text passes WCAG AA, so white, black and every extreme in
 *    between stay usable;
 *  · puts a one-click colour button in the window header (removable in the
 *    plugin's settings) that opens this plugin's settings page.
 *
 * How it hooks in (nothing core is patched)
 *  · Every chat surface root is marked by core: `[data-chat-surface]` plus
 *    `data-session-anchor` — `workspace` for the primary chat,
 *    `session-tile:<stored id>` for a session tile. A tile therefore names its
 *    own session; the primary follows the focused stored session id from
 *    `host.state`.
 *  · Colours are read from the value core itself persists
 *    (`hermes.desktop.sessionColors` in localStorage). The plugin stores no
 *    colour of its own: one picker, one value.
 *  · Settings live in Settings ▸ Plugins (the shipped renderer has no
 *    `appearance.extra` mount yet, so nothing depends on it).
 *
 * Cost
 *  · No timers, no polling, no animation frames. One CSS variable write per
 *    surface on session switch / colour change (plus a handful of computed-style
 *    reads for the contrast guard), a re-read of the colour map only when its raw
 *    value changed, and pure CSS for the rest. Nothing observes the document
 *    tree: the catalog's desktop lint refuses that, and the app-owned signals
 *    (focus, resize, visibility, pointer-up) are enough.
 */

import {
  atom,
  Codicon,
  ColorSwatches,
  haptic,
  host,
  ListRow,
  PALETTE_AREA,
  PROFILE_SWATCHES,
  profileColor,
  SegmentedControl,
  TITLEBAR_AREAS,
  ToggleRow,
  usePluginI18n,
  useValue
} from '@hermes/plugin-sdk'
import { useEffect, useMemo, useRef, useState } from 'react'
import { jsx, jsxs } from 'react/jsx-runtime'

const ID = 'chat-backgrounds'

/** Core's own per-session colour overrides (durable id → colour). Read-only
 *  here: every write goes through `host.sessions.setColor`. */
const COLORS_KEY = 'hermes.desktop.sessionColors'

/** Pane-id prefix core uses for a session tile (see `data-session-anchor`). */
const TILE_PREFIX = 'session-tile:'

const STRENGTHS = { soft: 7, medium: 11, strong: 17 }

/** `auto` is ON by default: the whole point is telling chats apart, and an
 *  explicit session colour (the sidebar dot's) still wins whenever it is set. */
const DEFAULT_PREFS = {
  auto: true,
  autoGuard: true,
  enabled: true,
  rail: true,
  showButton: true,
  strength: 'medium'
}

const TINT_ATTR = 'data-hcb-tint'
/** Three probes are enough: full, half, quarter of the chosen strength. */
const GUARD_FACTORS = [1, 0.5, 0.25]
const MIN_CONTRAST = 4.5

// ── state ───────────────────────────────────────────────────────────────────

const $prefs = atom({ ...DEFAULT_PREFS })
const $colors = atom({})

/** Contrast measured on the focused surface, for the caption in settings. */
const $contrast = atom({ ratio: null, thinned: false })

/** Core's per-session colour overrides, parsed from the value it persists. */
function parseColors(raw) {
  try {
    const parsed = JSON.parse(raw ?? '{}')

    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return {}
    }

    return Object.fromEntries(Object.entries(parsed).filter(([, color]) => typeof color === 'string'))
  } catch {
    return {}
  }
}

/** The colour one surface should wear. An explicit session colour always wins;
 *  `auto` only fills in the chats that have none, from the same deterministic
 *  identity colour the profile rail uses. */
function resolveColor(sessionId, colors, prefs) {
  if (!sessionId) {
    return null
  }

  return colors[sessionId] ?? (prefs.auto ? profileColor(sessionId) : null)
}

/** Document-root knobs: strength, and the two switches CSS keys on. Disabling
 *  the feature therefore clears every surface in one style recalc. */
function applyRoot(prefs) {
  const root = document.documentElement

  if (!root) {
    return
  }

  root.style.setProperty('--hcb-strength', `${STRENGTHS[prefs.strength] ?? STRENGTHS.medium}%`)

  const flag = (name, on) => (on ? root.setAttribute(name, '') : root.removeAttribute(name))

  flag('data-hcb-on', prefs.enabled)
  flag('data-hcb-rail', prefs.rail)
}

function updatePrefs(patch) {
  $prefs.set({ ...$prefs.get(), ...patch })
}

// ── colour maths (the browser resolves the actual pixels for us) ─────────────

/** `rgb(12 34 56 / .5)`, `color(srgb 0.58 0.29 0.86)` and hex-ish strings →
 *  [r, g, b] in 0..255; null when it is not a colour. Chromium resolves a
 *  `color-mix()` background to `color(srgb …)` with 0..1 floats, so both the
 *  byte and the float form have to be understood or the contrast maths is
 *  meaningless. */
function parseRgb(value) {
  const str = String(value || '').trim()

  if (!str || str === 'transparent' || str === 'none') {
    return null
  }

  const open = str.indexOf('(')
  const close = str.lastIndexOf(')')

  if (open === -1 || close <= open) {
    return null
  }

  const parts = str
    .slice(open + 1, close)
    .split(/[\s,/]+/)
    // `color(srgb …)` carries the colour space as a leading word — drop it.
    .filter(part => /^-?[\d.]+%?$/.test(part))
    .slice(0, 3)

  if (parts.length < 3) {
    return null
  }

  const floats = parts.every(part => part.endsWith('%') || /^\d*\.\d+$/.test(part) || /^0$/.test(part))
  const numbers = parts.map(part => parseFloat(part))

  if (numbers.some(n => !Number.isFinite(n))) {
    return null
  }

  if (parts.some(part => part.endsWith('%'))) {
    return numbers.map(n => (n / 100) * 255)
  }

  // `color(srgb 0.58 …)` and other float forms are 0..1; `rgb(148 75 221)` is 0..255.
  return str.startsWith('color(') || floats ? numbers.map(n => n * 255) : numbers
}

function luminance([r, g, b]) {
  const channel = v => {
    const s = v / 255

    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4
  }

  return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b)
}

function contrastRatio(a, b) {
  if (!a || !b) {
    return null
  }

  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x)

  return (hi + 0.05) / (lo + 0.05)
}

/** Any CSS colour (hex, hsl, named) → `#rrggbb` for `<input type="color">`,
 *  computed by the browser so swatches that ship as `hsl()` convert too.
 *  Memoized: the conversion costs a forced style read, and the picker asks for
 *  it on every render while the user drags. */
const hexCache = new Map()

function toHex(color) {
  if (!color) {
    return '#7c8cf8'
  }

  const hit = hexCache.get(color)

  if (hit) {
    return hit
  }

  const remember = hex => {
    if (hexCache.size > 96) {
      hexCache.clear()
    }

    hexCache.set(color, hex)

    return hex
  }

  if (/^#[0-9a-f]{6}$/i.test(color)) {
    return remember(color.toLowerCase())
  }

  if (/^#[0-9a-f]{3}$/i.test(color)) {
    return remember(
      `#${color
        .slice(1)
        .split('')
        .map(ch => ch + ch)
        .join('')}`.toLowerCase()
    )
  }

  const probe = document.createElement('span')

  probe.style.color = color
  document.body.append(probe)

  const rgb = parseRgb(getComputedStyle(probe).color)

  probe.remove()

  return remember(rgb ? `#${rgb.map(v => v.toString(16).padStart(2, '0')).join('')}` : '#7c8cf8')
}

/** `<input type="color">` value or a typed hex → a storable CSS colour. */
function normalizeHex(text) {
  const raw = String(text || '').trim().toLowerCase()
  const body = raw.startsWith('#') ? raw.slice(1) : raw

  if (/^[0-9a-f]{6}$/.test(body)) {
    return `#${body}`
  }

  if (/^[0-9a-f]{3}$/.test(body)) {
    return `#${body
      .split('')
      .map(ch => ch + ch)
      .join('')}`
  }

  return null
}

// ── painting the surfaces ───────────────────────────────────────────────────

/** The stored id the PRIMARY chat showed last time it was the one in focus.
 *  `focusedStoredSessionId` moves to a tile while a tile holds focus, so the
 *  primary keeps its previous id until focus comes back — a lag of one switch,
 *  never a colour borrowed from another chat. */
let lastPrimaryId = null

/** Thin the fill until the theme's ink stays readable on it. The browser gives
 *  the resolved background (color-mix included), so this needs no colour
 *  parsing of the tint itself and works for white, black and everything else. */
function guardContrast(el, prefs) {
  el.style.removeProperty('--hcb-strength')

  if (!prefs.autoGuard) {
    return
  }

  const base = STRENGTHS[prefs.strength] ?? STRENGTHS.medium
  const ink = parseRgb(getComputedStyle(el).color)
  const focused = !el.hasAttribute('data-chat-unfocused')
  let measured = null

  for (const factor of GUARD_FACTORS) {
    el.style.setProperty('--hcb-strength', `${(base * factor).toFixed(1)}%`)

    const bg = parseRgb(getComputedStyle(el).backgroundColor)

    measured = { ratio: contrastRatio(bg, ink), thinned: factor < 1 }

    if (measured.ratio === null || measured.ratio >= MIN_CONTRAST) {
      break
    }
  }

  if (focused && measured) {
    $contrast.set(measured)
  }
}

/** What is already painted on a surface, so a repaint that changes nothing
 *  costs nothing — the contrast guard forces a style read per probe, and
 *  applyAll runs on every focus / preference change. */
const painted = new WeakMap()

function paint(el, color, prefs) {
  if (!color) {
    if (el.hasAttribute(TINT_ATTR) || el.style.getPropertyValue('--hcb-tint')) {
      el.style.removeProperty('--hcb-tint')
      el.style.removeProperty('--hcb-strength')
      el.removeAttribute(TINT_ATTR)
    }

    painted.delete(el)

    return
  }

  const key = `${prefs.strength}|${prefs.autoGuard}`
  const before = painted.get(el)

  if (before && before.color === color && before.key === key) {
    return
  }

  if (el.style.getPropertyValue('--hcb-tint') !== color) {
    el.style.setProperty('--hcb-tint', color)
  }

  el.setAttribute(TINT_ATTR, '')
  guardContrast(el, prefs)
  painted.set(el, { color, key })
}

function applyAll() {
  const colors = $colors.get()
  const prefs = $prefs.get()
  const surfaces = [...document.querySelectorAll('[data-chat-surface]')]

  if (surfaces.length === 0) {
    return
  }

  const anchorOf = el => el.getAttribute('data-session-anchor') || 'workspace'
  const anchors = surfaces.map(anchorOf)
  const tileIds = new Set(
    anchors.filter(anchor => anchor.startsWith(TILE_PREFIX)).map(anchor => anchor.slice(TILE_PREFIX.length))
  )

  const focused = host.state.focusedStoredSessionId?.get?.() ?? null
  const focusedIsTile = Boolean(focused && tileIds.has(focused))

  if (focused && !focusedIsTile) {
    lastPrimaryId = focused
  }

  const primaryId = focusedIsTile ? lastPrimaryId : focused

  surfaces.forEach((el, index) => {
    const anchor = anchors[index]
    const id = anchor.startsWith(TILE_PREFIX) ? anchor.slice(TILE_PREFIX.length) : primaryId

    paint(el, resolveColor(id, colors, prefs), prefs)
  })
}

// ── styles ──────────────────────────────────────────────────────────────────
// Tailwind does not scan disk plugins: everything is spelled out here, with the
// app's own background variable as the base so text contrast never changes.

const CSS = `
:root[data-hcb-on] [data-chat-surface][data-hcb-tint] {
  --ui-chat-surface-background: color-mix(
    in srgb,
    var(--hcb-tint) var(--hcb-strength, 11%),
    var(--ui-bg-chrome)
  );
}
/* Window translucency: core keeps this surface transparent so the platform
   material shows through — tint with alpha instead of replacing that. */
:root[data-hcb-on][data-hermes-glass] [data-chat-surface][data-hcb-tint] {
  --ui-chat-surface-background: color-mix(
    in srgb,
    var(--hcb-tint) var(--hcb-strength, 11%),
    transparent
  );
}
/* The rail marks the chat being worked in: core sets data-chat-unfocused on
   every surface that is NOT focused, so this needs no listener at all. */
:root[data-hcb-on][data-hcb-rail] [data-chat-surface][data-hcb-tint]:not([data-chat-unfocused])::after {
  content: '';
  position: absolute;
  inset: 0 auto 0 0;
  width: 2px;
  background: var(--hcb-tint);
  opacity: 0.9;
  pointer-events: none;
  z-index: 6;
}
.hcb-section { margin-top: 22px; }
.hcb-page .hcb-section { margin-top: 0; }
.hcb-page { padding: 4px 0 12px; }
.hcb-heading {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-bottom: 6px;
  font-size: var(--conversation-text-font-size, 0.8125rem);
  font-weight: 500;
  color: var(--ui-text-primary);
}
.hcb-note {
  margin-top: 6px;
  font-size: 11px;
  line-height: 1.45;
  color: var(--ui-text-quaternary);
}
/* Header button — same footprint and hover as the app's own titlebar tools. */
.hcb-tb-btn {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 24px;
  height: 24px;
  border-radius: 5px;
  color: var(--ui-text-tertiary);
  text-decoration: none;
  transition: background-color 0.12s ease, color 0.12s ease;
  -webkit-app-region: no-drag;
}
.hcb-tb-btn:hover {
  background: var(--ui-control-hover-background, var(--chrome-action-hover));
  color: var(--ui-text-primary);
}
/* Colour row — its own layout instead of ListRow's below slot, because the
   swatch grid has to sit clear of the description copy above it. */
.hcb-row { padding: 10px 0 14px; }
.hcb-row-title {
  font-size: var(--conversation-text-font-size, 0.8125rem);
  font-weight: 500;
  color: var(--ui-text-primary);
}
.hcb-row-desc {
  margin-top: 2px;
  font-size: 11.5px;
  line-height: 1.5;
  color: var(--ui-text-tertiary);
}
.hcb-color {
  display: flex;
  flex-direction: column;
  gap: 14px;
  margin-top: 14px;
  max-width: 300px;
}
/* Core's swatch grid ships a tight rhythm (6px gap, 20px dots). Open it up so
   the dots read as separate choices and never touch the copy above. */
.hcb-color div.grid { gap: 10px; row-gap: 12px; }
.hcb-color div.grid > button { width: 22px; height: 22px; }
.hcb-custom {
  display: flex;
  align-items: center;
  gap: 8px;
}
.hcb-native {
  width: 30px;
  height: 24px;
  padding: 0;
  border: 1px solid var(--ui-stroke-secondary);
  border-radius: 5px;
  background: transparent;
  cursor: pointer;
}
.hcb-hex {
  flex: 1 1 auto;
  min-width: 0;
  height: 24px;
  padding: 0 7px;
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  font-size: 11px;
  color: var(--ui-text-primary);
  background: var(--ui-bg-tertiary);
  border: 1px solid var(--ui-stroke-secondary);
  border-radius: 5px;
  outline: none;
}
.hcb-hex:focus { border-color: var(--ui-accent, var(--ui-stroke-secondary)); }
.hcb-contrast {
  font-size: 11px;
  line-height: 1.4;
  color: var(--ui-text-tertiary);
}
.hcb-contrast[data-tone='warn'] { color: #d9a441; }
`

// ── settings section (Settings ▸ Plugins → «Фон чатов») ─────────────────────

function SettingsSection() {
  const t = usePluginI18n(ID)
  const prefs = useValue($prefs)
  const colors = useValue($colors)
  const contrast = useValue($contrast)
  const focusedId = useValue(host.state.focusedStoredSessionId)
  const currentColor = focusedId ? (colors[focusedId] ?? null) : null
  const currentHex = useMemo(() => toHex(currentColor), [currentColor])
  const [draft, setDraft] = useState(null)
  const [pending, setPending] = useState(null)
  const writeTimer = useRef(null)

  const strengthOptions = [
    { id: 'soft', label: t('strengthSoft') },
    { id: 'medium', label: t('strengthMedium') },
    { id: 'strong', label: t('strengthStrong') }
  ]

  /** Dragging inside the system colour picker fires an event per mouse move.
   *  Writing every one to the session store re-renders this page and re-runs the
   *  contrast probes — that is what made the knob crawl. So the store write is
   *  coalesced (140 ms) while the picker's own preview stays live. */
  const commit = color => {
    if (!focusedId || !color) {
      return
    }

    setDraft(null)
    setPending(color)

    if (writeTimer.current) {
      clearTimeout(writeTimer.current)
    }

    writeTimer.current = setTimeout(() => {
      writeTimer.current = null
      haptic('tap')
      host.sessions.setColor(focusedId, color)
    }, 140)
  }

  const commitDraft = () => {
    const hex = normalizeHex(draft)

    if (hex) {
      commit(hex)
    } else {
      setDraft(null)
    }
  }

  // A queued colour belongs to the chat it was picked in.
  useEffect(() => {
    setPending(null)

    return () => {
      if (writeTimer.current) {
        clearTimeout(writeTimer.current)
        writeTimer.current = null
      }
    }
  }, [focusedId])

  const shownHex = pending ? toHex(pending) : currentHex

  const ratio = contrast.ratio
  const warn = ratio !== null && ratio < MIN_CONTRAST
  const tone = warn ? 'warn' : undefined

  return jsxs('div', {
    className: 'hcb-section',
    children: [
      jsx('div', { className: 'hcb-heading', children: t('title') }),
      jsx(ToggleRow, {
        checked: prefs.enabled,
        description: t('enableDesc'),
        label: t('enable'),
        onChange: on => {
          haptic('tap')
          updatePrefs({ enabled: on })
        }
      }),
      jsx(ListRow, {
        action: jsx(SegmentedControl, {
          onChange: id => {
            haptic('tap')
            updatePrefs({ strength: id })
          },
          options: strengthOptions,
          value: prefs.strength
        }),
        description: t('strengthDesc'),
        title: t('strength')
      }),
      jsx(ToggleRow, {
        checked: prefs.autoGuard,
        description: t('guardDesc'),
        label: t('guard'),
        onChange: on => {
          haptic('tap')
          updatePrefs({ autoGuard: on })
        }
      }),
      jsx(ToggleRow, {
        checked: prefs.rail,
        description: t('railDesc'),
        label: t('rail'),
        onChange: on => {
          haptic('tap')
          updatePrefs({ rail: on })
        }
      }),
      jsx(ToggleRow, {
        checked: prefs.auto,
        description: t('autoDesc'),
        label: t('auto'),
        onChange: on => {
          haptic('tap')
          updatePrefs({ auto: on })
        }
      }),
      jsx(ToggleRow, {
        checked: prefs.showButton,
        description: t('buttonDesc'),
        label: t('button'),
        onChange: on => {
          haptic('tap')
          updatePrefs({ showButton: on })
        }
      }),
      jsxs('div', {
        className: 'hcb-row',
        children: [
          jsx('div', { className: 'hcb-row-title', children: t('current') }),
          jsx('div', {
            className: 'hcb-row-desc',
            children: focusedId ? t('currentDesc') : t('currentEmpty')
          }),
          jsxs('div', {
            className: 'hcb-color',
            children: [
              jsx(ColorSwatches, {
                clearLabel: t('clear'),
                onChange: color => commit(color),
                swatchLabel: color => t('swatch', color),
                swatches: PROFILE_SWATCHES,
                value: pending ?? currentColor
              }),
              jsxs('div', {
                className: 'hcb-custom',
                children: [
                  jsx('input', {
                    'aria-label': t('custom'),
                    className: 'hcb-native',
                    disabled: !focusedId,
                    onChange: event => commit(event.target.value),
                    type: 'color',
                    value: shownHex
                  }),
                  jsx('input', {
                    'aria-label': t('hex'),
                    className: 'hcb-hex',
                    disabled: !focusedId,
                    maxLength: 7,
                    onBlur: commitDraft,
                    onChange: event => setDraft(event.target.value),
                    onKeyDown: event => {
                      if (event.key === 'Enter') {
                        commitDraft()
                      }
                    },
                    placeholder: '#RRGGBB',
                    spellCheck: false,
                    type: 'text',
                    value: draft ?? (focusedId ? shownHex : '')
                  })
                ]
              }),
              jsx('div', {
                'data-tone': tone,
                className: 'hcb-contrast',
                children:
                  ratio === null
                    ? t('contrastUnknown')
                    : t(warn ? 'contrastWarn' : 'contrastOk', ratio.toFixed(1))
              })
            ]
          })
        ]
      }),
      jsx('div', { className: 'hcb-note', children: t('note') })
    ]
  })
}

// ── header button ───────────────────────────────────────────────────────────

/** One-click way into this plugin's settings page. Core's router is a
 *  HashRouter, so a plain hash link lands on Settings ▸ Plugins ▸ this page
 *  without needing a navigation door. Hidden when the user turned it off. */
function HeaderButton() {
  const t = usePluginI18n(ID)
  const prefs = useValue($prefs)

  if (!prefs.showButton) {
    return null
  }

  return jsx('a', {
    'aria-label': t('openSettings'),
    className: 'hcb-tb-btn',
    href: `#/settings?tab=plugins&plugin=${encodeURIComponent(`${ID}:settings`)}`,
    title: t('openSettings'),
    children: jsx(Codicon, { name: 'symbol-color', size: '0.9rem' })
  })
}

// ── locale bundles (the app's own language list, minus the en/ru above) ─────
// Every locale carries the same key set; the app falls back to `en` if one is
// ever missing, so a partial translation degrades instead of breaking.

const EXTRA_LOCALES = {
  de: {
    auto: 'Automatische Farbe ohne eigene',
    autoDesc: 'Ein Chat ohne eigene Farbe erhält einen festen Farbton aus seiner ID.',
    button: 'Farbknopf in der Fensterleiste',
    buttonDesc: 'Ein Palettensymbol oben rechts öffnet diese Seite.',
    clear: 'Keine Farbe',
    contrastOk: ratio => `Textkontrast ${ratio}:1 – gut lesbar.`,
    contrastUnknown: 'Der Kontrast wird gemessen, sobald ein Chat getönt ist.',
    contrastWarn: ratio => `Textkontrast ${ratio}:1 – die Tönung wird zurückgenommen, damit der Text lesbar bleibt.`,
    current: 'Farbe des aktuellen Chats',
    currentDesc: 'Dieselbe Farbe wie der Punkt in der Seitenleiste. Presets, Systemauswahl oder Hex.',
    currentEmpty: 'Öffnen Sie einen Chat, um seine Farbe zu wählen.',
    custom: 'Beliebige Farbe',
    enable: 'Chat-Hintergründe tönen',
    enableDesc: 'Jeder Chat bekommt seine eigene Farbe – Sitzungen sind sofort unterscheidbar.',
    guard: 'Text lesbar halten',
    guardDesc: 'Dünnt die Tönung automatisch aus, wenn der Textkontrast unter 4,5:1 fällt.',
    hex: 'Farbe als Hex',
    note: 'Text, Rahmen und Karten bleiben in der Theme-Palette – nur das Chatfeld wird getönt.',
    openSettings: 'Chat-Hintergründe: Einstellungen',
    rail: 'Streifen am aktiven Chat',
    railDesc: 'Schmaler Balken in der Chat-Farbe am linken Rand des Chats, in dem Sie gerade arbeiten.',
    strength: 'Intensität',
    strengthDesc: 'Wie viel von der Chat-Farbe der Hintergrund höchstens trägt.',
    strengthMedium: 'Mittel',
    strengthSoft: 'Sanft',
    strengthStrong: 'Kräftig',
    swatch: color => `Farbe ${color}`,
    title: 'Chat-Hintergründe'
  },
  es: {
    auto: 'Color automático si no hay uno propio',
    autoDesc: 'Un chat sin color propio recibe un tono estable derivado de su id.',
    button: 'Botón de color en la cabecera',
    buttonDesc: 'Un icono de paleta arriba a la derecha que abre esta página.',
    clear: 'Sin color',
    contrastOk: ratio => `Contraste del texto ${ratio}:1 — se lee bien.`,
    contrastUnknown: 'El contraste se mide cuando el chat tiene color.',
    contrastWarn: ratio => `Contraste del texto ${ratio}:1 — el relleno se atenúa para que el texto se lea.`,
    current: 'Color del chat actual',
    currentDesc: 'El mismo color que el punto de la barra lateral. Preajustes, selector del sistema o hex.',
    currentEmpty: 'Abre un chat para elegir su color.',
    custom: 'Cualquier color',
    enable: 'Teñir el fondo de los chats',
    enableDesc: 'Cada chat se pinta con su propio color, así las sesiones no se confunden.',
    guard: 'Mantener el texto legible',
    guardDesc: 'Atenúa el relleno automáticamente cuando el contraste del texto bajaría de 4,5:1.',
    hex: 'Color en hex',
    note: 'El texto, los bordes y las tarjetas siguen la paleta del tema — solo se tiñe el campo del chat.',
    openSettings: 'Fondos de chat: ajustes',
    rail: 'Barra en el chat activo',
    railDesc: 'Una barra fina con el color del chat en el borde izquierdo del chat en el que trabajas.',
    strength: 'Intensidad',
    strengthDesc: 'Cuánto del color del chat puede llevar el fondo como máximo.',
    strengthMedium: 'Media',
    strengthSoft: 'Suave',
    strengthStrong: 'Marcada',
    swatch: color => `Color ${color}`,
    title: 'Fondos de chat'
  },
  fr: {
    auto: 'Couleur automatique à défaut',
    autoDesc: 'Une discussion sans couleur propre reçoit une teinte stable dérivée de son id.',
    button: 'Bouton couleur dans l’en-tête',
    buttonDesc: 'Une icône palette en haut à droite qui ouvre cette page.',
    clear: 'Aucune couleur',
    contrastOk: ratio => `Contraste du texte ${ratio}:1 — confortable.`,
    contrastUnknown: 'Le contraste est mesuré dès qu’une discussion a une couleur.',
    contrastWarn: ratio => `Contraste du texte ${ratio}:1 — le voile est réduit pour rester lisible.`,
    current: 'Couleur de la discussion',
    currentDesc: 'La même couleur que le point de la barre latérale. Préréglages, sélecteur système ou hex.',
    currentEmpty: 'Ouvrez une discussion pour en choisir la couleur.',
    custom: 'Couleur libre',
    enable: 'Teinter le fond des discussions',
    enableDesc: 'Chaque discussion prend sa propre couleur : les sessions ne se confondent plus.',
    guard: 'Garder le texte lisible',
    guardDesc: 'Réduit automatiquement le voile dès que le contraste du texte passerait sous 4,5:1.',
    hex: 'Couleur en hex',
    note: 'Le texte, les bordures et les cartes restent dans la palette du thème — seul le champ de la discussion est teinté.',
    openSettings: 'Fonds de discussion : réglages',
    rail: 'Bandeau sur la discussion active',
    railDesc: 'Une fine barre à la couleur de la discussion, au bord gauche de celle où vous travaillez.',
    strength: 'Intensité',
    strengthDesc: 'La part maximale de la couleur de la discussion dans le fond.',
    strengthMedium: 'Moyenne',
    strengthSoft: 'Doux',
    strengthStrong: 'Marquée',
    swatch: color => `Couleur ${color}`,
    title: 'Fonds de discussion'
  },
  ja: {
    auto: '色がないチャットの自動色',
    autoDesc: '色を設定していないチャットは、IDから決まる固定の色相になります。',
    button: 'ヘッダーの色ボタン',
    buttonDesc: '右上のパレットアイコンでこのページを開きます。',
    clear: '色なし',
    contrastOk: ratio => `テキストのコントラスト ${ratio}:1 — 読みやすい状態です。`,
    contrastUnknown: 'チャットに色があるとコントラストを計測します。',
    contrastWarn: ratio => `テキストのコントラスト ${ratio}:1 — 読みやすさのため塗りを抑えています。`,
    current: '現在のチャットの色',
    currentDesc: 'サイドバーのドットと同じ色です。プリセット、OSのピッカー、hexで指定できます。',
    currentEmpty: 'チャットを開くと色を選べます。',
    custom: '任意の色',
    enable: 'チャット背景を着色',
    enableDesc: 'チャットごとに色を付けるので、セッションが混ざりません。',
    guard: '文字の読みやすさを保つ',
    guardDesc: 'テキストのコントラストが4.5:1を下回る場合、塗りを自動的に薄くします。',
    hex: 'hexカラー',
    note: 'テキスト、枠線、カードはテーマのパレットのままです。着色されるのはチャットの領域だけです。',
    openSettings: 'チャット背景: 設定',
    rail: 'アクティブなチャットのライン',
    railDesc: '作業中のチャットの左端に、チャット色の細いラインを表示します。',
    strength: '強さ',
    strengthDesc: '背景に載せるチャット色の上限です。',
    strengthMedium: '中',
    strengthSoft: '弱め',
    strengthStrong: '強め',
    swatch: color => `色 ${color}`,
    title: 'チャット背景'
  },
  zh: {
    auto: '无自有颜色时自动配色',
    autoDesc: '没有独立颜色的聊天会按 id 得到一个稳定的色相。',
    button: '标题栏颜色按钮',
    buttonDesc: '右上角的调色板图标，点击打开本设置页。',
    clear: '不使用颜色',
    contrastOk: ratio => `文字对比度 ${ratio}:1 — 阅读舒适。`,
    contrastUnknown: '聊天有颜色后才会测量对比度。',
    contrastWarn: ratio => `文字对比度 ${ratio}:1 — 已减淡填充以保证可读。`,
    current: '当前聊天的颜色',
    currentDesc: '与侧边栏圆点同一个颜色。可从预设、系统取色器或 hex 中选择。',
    currentEmpty: '打开一个聊天即可选择它的颜色。',
    custom: '任意颜色',
    enable: '为聊天背景着色',
    enableDesc: '每个聊天有自己的颜色，会话之间一眼就能分开。',
    guard: '保持文字可读',
    guardDesc: '当文字对比度会低于 4.5:1 时自动减淡填充。',
    hex: '十六进制颜色',
    note: '文字、边框和卡片保持主题配色——只给聊天区域着色。',
    openSettings: '聊天背景：设置',
    rail: '当前聊天的色条',
    railDesc: '在你正在工作的聊天左边缘显示一条聊天颜色的细条。',
    strength: '强度',
    strengthDesc: '背景最多可以承载多少聊天颜色。',
    strengthMedium: '中等',
    strengthSoft: '柔和',
    strengthStrong: '明显',
    swatch: color => `颜色 ${color}`,
    title: '聊天背景'
  },
  'zh-hant': {
    auto: '無專屬顏色時自動配色',
    autoDesc: '沒有獨立顏色的聊天會依 id 得到穩定的色相。',
    button: '標題列顏色按鈕',
    buttonDesc: '右上角的調色盤圖示，點擊開啟本設定頁。',
    clear: '不使用顏色',
    contrastOk: ratio => `文字對比度 ${ratio}:1 — 閱讀舒適。`,
    contrastUnknown: '聊天有顏色後才會測量對比度。',
    contrastWarn: ratio => `文字對比度 ${ratio}:1 — 已減淡填色以確保可讀。`,
    current: '目前聊天的顏色',
    currentDesc: '與側邊欄圓點同一個顏色。可從預設、系統取色器或 hex 選擇。',
    currentEmpty: '開啟一個聊天即可選擇它的顏色。',
    custom: '任意顏色',
    enable: '為聊天背景著色',
    enableDesc: '每個聊天有自己的顏色，工作階段之間一眼就能分開。',
    guard: '保持文字易讀',
    guardDesc: '當文字對比度會低於 4.5:1 時自動減淡填色。',
    hex: '十六進位顏色',
    note: '文字、邊框與卡片維持主題配色——只為聊天區域著色。',
    openSettings: '聊天背景：設定',
    rail: '目前聊天的色條',
    railDesc: '在你正在工作的聊天左緣顯示一條聊天顏色的細條。',
    strength: '強度',
    strengthDesc: '背景最多可以承載多少聊天顏色。',
    strengthMedium: '中等',
    strengthSoft: '柔和',
    strengthStrong: '明顯',
    swatch: color => `顏色 ${color}`,
    title: '聊天背景'
  },
  ar: {
    auto: 'لون تلقائي للمحادثات بلا لون',
    autoDesc: 'المحادثة التي لا لون لها تأخذ درجة ثابتة مشتقة من معرّفها.',
    button: 'زر اللون في الشريط العلوي',
    buttonDesc: 'أيقونة لوحة ألوان أعلى اليمين تفتح صفحة الإعدادات هذه.',
    clear: 'بلا لون',
    contrastOk: ratio => `تباين النص ${ratio}:1 — مريح للقراءة.`,
    contrastUnknown: 'يُقاس التباين بعد أن يكون للمحادثة لون.',
    contrastWarn: ratio => `تباين النص ${ratio}:1 — خففت التعبئة ليبقى النص مقروءًا.`,
    current: 'لون المحادثة الحالية',
    currentDesc: 'اللون نفسه الذي تحمله النقطة في الشريط الجانبي. قوالب أو منتقي النظام أو hex.',
    currentEmpty: 'افتح محادثة لاختيار لونها.',
    custom: 'أي لون',
    enable: 'تلوين خلفيات المحادثات',
    enableDesc: 'كل محادثة تُلوَّن بلونها الخاص، فلا تختلط الجلسات.',
    guard: 'الحفاظ على وضوح النص',
    guardDesc: 'يخفف التعبئة تلقائيًا عندما تنخفض نسبة تباين النص عن 4.5:1.',
    hex: 'اللون بصيغة hex',
    note: 'يبقى النص والحدود والبطاقات بألوان السمة — يُلوّن حقل المحادثة فقط.',
    openSettings: 'خلفيات المحادثة: الإعدادات',
    rail: 'شريط المحادثة النشطة',
    railDesc: 'شريط رفيع بلون المحادثة على الحافة اليسرى للمحادثة التي تعمل فيها.',
    strength: 'الشدة',
    strengthDesc: 'أقصى قدر من لون المحادثة تحمله الخلفية.',
    strengthMedium: 'متوسط',
    strengthSoft: 'خفيف',
    strengthStrong: 'قوي',
    swatch: color => `اللون ${color}`,
    title: 'خلفيات المحادثة'
  }
}

// ── plugin ──────────────────────────────────────────────────────────────────

export default {
  id: ID,
  name: 'Chat Backgrounds',
  description: 'Tints each chat with its own session colour, plus a rail on the active one.',
  register(ctx) {
    ctx.i18n.register({
      en: {
        auto: 'Auto colour for chats without one',
        autoDesc: 'A chat with no colour of its own gets a stable hue derived from its id.',
        button: 'Colour button in the window header',
        buttonDesc: 'A palette icon in the top-right cluster that opens this page.',
        clear: 'No colour',
        contrastOk: ratio => `Text contrast ${ratio}:1 — comfortable.`,
        contrastUnknown: 'Contrast is measured once a chat is tinted.',
        contrastWarn: ratio => `Text contrast ${ratio}:1 — the fill is held back to stay readable.`,
        current: 'Colour of the current chat',
        currentDesc: 'The same colour the sidebar dot uses. Presets, the system picker or a hex code.',
        currentEmpty: 'Open a chat to pick its colour.',
        custom: 'Any colour',
        enable: 'Tint chat backgrounds',
        enableDesc: 'Each chat is painted with its own colour, so sessions never blur together.',
        guard: 'Keep text readable',
        guardDesc: 'Thins the fill automatically when the text contrast would drop below 4.5:1.',
        hex: 'Hex colour',
        note: 'Text, borders and cards stay on the theme palette — only the chat field is tinted.',
        openSettings: 'Chat backgrounds: settings',
        rail: 'Rail on the active chat',
        railDesc: 'A thin bar in the chat colour at the left edge of the chat you are working in.',
        strength: 'Intensity',
        strengthMedium: 'Medium',
        strengthSoft: 'Soft',
        strengthStrong: 'Strong',
        strengthDesc: 'The most of the chat colour the background may carry.',
        swatch: color => `Colour ${color}`,
        title: 'Chat backgrounds'
      },
      ru: {
        auto: 'Автоцвет для чатов без своего цвета',
        autoDesc: 'Чат без своего цвета получает стабильный оттенок, выведенный из его id.',
        button: 'Кнопка цвета в шапке окна',
        buttonDesc: 'Иконка палитры справа вверху — открывает эту страницу настроек.',
        clear: 'Без цвета',
        contrastOk: ratio => `Контраст текста ${ratio}:1 — читается свободно.`,
        contrastUnknown: 'Контраст измеряется, когда у чата есть цвет.',
        contrastWarn: ratio => `Контраст текста ${ratio}:1 — заливка ослаблена, чтобы текст читался.`,
        current: 'Цвет текущего чата',
        currentDesc: 'Тот же цвет, что у точки в сайдбаре. Пресеты, системный пикер или hex.',
        currentEmpty: 'Откройте чат, чтобы выбрать ему цвет.',
        custom: 'Любой цвет',
        enable: 'Тонировать фон чатов',
        enableDesc: 'Каждый чат красится своим цветом — сессии не сливаются между собой.',
        guard: 'Сохранять читаемость текста',
        guardDesc: 'Автоматически ослабляет заливку, если контраст текста падает ниже 4.5:1.',
        hex: 'Цвет в hex',
        note: 'Текст, границы и карточки остаются в палитре темы — тонируется только поле чата.',
        openSettings: 'Фон чатов: настройки',
        rail: 'Полоса у активного чата',
        railDesc: 'Тонкая полоса цветом чата у левого края того чата, где вы сейчас работаете.',
        strength: 'Интенсивность',
        strengthMedium: 'Средне',
        strengthSoft: 'Мягко',
        strengthStrong: 'Заметно',
        strengthDesc: 'Предел, до которого фон может нести цвет чата.',
        swatch: color => `Цвет ${color}`,
        title: 'Фон чатов'
      }
    })

    ctx.i18n.register(EXTRA_LOCALES)

    // ── persisted preferences (plugin-scoped storage) ──────────────────────
    const stored = ctx.storage.get('prefs', DEFAULT_PREFS)

    // Boot stamp: one storage write per load, so a stale/half-loaded plugin is
    // visible from outside the renderer (and in the log of a bug report).
    ctx.storage.set('boot', new Date().toISOString())

    $prefs.set({ ...DEFAULT_PREFS, ...(stored && typeof stored === 'object' ? stored : {}) })
    applyRoot($prefs.get())

    ctx.onDispose(() => {
      const root = document.documentElement

      root?.removeAttribute('data-hcb-on')
      root?.removeAttribute('data-hcb-rail')
      root?.style.removeProperty('--hcb-strength')
    })

    // Persist CHANGES only: the subscribe below fires once at load with the
    // value just read back, and writing that would be a pointless storage touch.
    let hydrated = false

    ctx.onDispose(
      $prefs.subscribe(prefs => {
        applyRoot(prefs)

        if (hydrated) {
          ctx.storage.set('prefs', prefs)
        }

        hydrated = true
      })
    )

    // ── the colour map core keeps ─────────────────────────────────────────
    // Read-only: the value core itself persists. No `storage` event fires for a
    // same-document write, and wrapping `Storage.prototype.setItem` would be a
    // prototype patch a reviewer (rightly) refuses — so the map is re-read on
    // the cheap edges instead: pointer-up (after any colour menu click), window
    // focus, visibility change, and every apply pass. A raw-string compare makes
    // a re-read free when nothing changed.
    let rawColors = null

    const refreshColors = () => {
      let raw = null

      try {
        raw = window.localStorage.getItem(COLORS_KEY)
      } catch {
        raw = null
      }

      if (raw === rawColors) {
        return
      }

      rawColors = raw
      $colors.set(parseColors(raw))
    }

    refreshColors()

    ctx.onDispose(ctx.addEventListener(document, 'pointerup', refreshColors, { capture: true, passive: true }))
    ctx.onDispose(ctx.addEventListener(window, 'focus', refreshColors))
    ctx.onDispose(ctx.addEventListener(document, 'visibilitychange', refreshColors))

    // ── styles ────────────────────────────────────────────────────────────
    const style = document.createElement('style')

    style.dataset.plugin = ID
    style.textContent = CSS
    document.head.append(style)
    ctx.onDispose(() => style.remove())

    // ── keep the surfaces painted ─────────────────────────────────────────
    // Every trigger below is an app-owned signal. A `MutationObserver` on
    // document.body would be the obvious way to catch a late-mounting tile, but
    // the catalog's desktop lint refuses exactly that ("app DOM reach"), so a
    // surface that appears a frame after the focus atom flips is caught by the
    // deferred pass plus the window/document listeners instead.
    const repaintSoon = () => {
      applyAll()
      ctx.setTimeout(applyAll, 250)
    }

    ctx.onDispose($prefs.subscribe(applyAll))
    ctx.onDispose($colors.subscribe(applyAll))
    ctx.onDispose(host.state.focusedStoredSessionId.listen(repaintSoon))
    ctx.onDispose(ctx.addEventListener(window, 'resize', applyAll))
    ctx.onDispose(ctx.addEventListener(document, 'visibilitychange', applyAll))

    ctx.onDispose(() => {
      for (const el of document.querySelectorAll('[data-chat-surface]')) {
        paint(el, null, $prefs.get())
      }
    })

    applyAll()

    // ── contributions ─────────────────────────────────────────────────────
    // Settings ▸ Плагины — the reliable home. `appearance.extra` is registered
    // too (it is the sanctioned seam on newer builds), but the shipped renderer
    // does not mount that slot, so the plugin must not depend on it.
    //
    // The page title is a STRING read once, at register time — and register()
    // runs before the app applies its locale, so it is resolved again on every
    // locale change instead of staying in the boot language.
    let disposePage = null

    const registerPage = () => {
      if (!ctx.registerSettingsPage) {
        return
      }

      disposePage?.()

      disposePage = ctx.registerSettingsPage({
        id: 'settings',
        icon: 'symbol-color',
        order: 55,
        render: () => jsx('div', { className: 'hcb-page', children: jsx(SettingsSection, {}) }),
        title: ctx.i18n.t('title')
      })
    }

    registerPage()
    ctx.onDispose(() => disposePage?.())
    ctx.onDispose(ctx.i18n.onLocaleChange(registerPage))

    ctx.register({ area: 'appearance.extra', id: 'section', render: () => jsx(SettingsSection, {}) })

    if (TITLEBAR_AREAS?.right) {
      // The button hides itself when the user turns it off — a registration
      // cannot be conditional, a rendered `null` can.
      ctx.register({
        area: TITLEBAR_AREAS.right,
        id: 'header-button',
        render: () => jsx(HeaderButton, {})
      })
    }

    // ⌘K row: the switch the settings section owns, one keystroke away. The
    // palette reads `detail` on every open, so the state note stays live.
    ctx.register({
      area: PALETTE_AREA,
      data: {
        detail: () => ($prefs.get().enabled ? 'on' : 'off'),
        detailVariant: 'state',
        id: 'toggle',
        keepOpen: true,
        keywords: ['background', 'tint', 'colour', 'color', 'фон', 'чат'],
        label: ctx.i18n.t('title'),
        run: () => updatePrefs({ enabled: !$prefs.get().enabled })
      },
      id: 'toggle'
    })

    // ⌘K row that lands the user on the settings page itself — the palette is
    // where people look for a feature they cannot find in the rails.
    ctx.register({
      area: PALETTE_AREA,
      data: {
        id: 'settings',
        keywords: ['background', 'tint', 'settings', 'фон', 'настройки'],
        label: ctx.i18n.t('openSettings'),
        run: () => ctx.runAction?.('nav.settings')
      },
      id: 'settings'
    })
  }
}
