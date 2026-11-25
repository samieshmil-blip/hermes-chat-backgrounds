/**
 * Regression tests for the contrast guard in `desktop/plugin.js`.
 *
 * The guard is plain maths over a background the browser resolved, so the test
 * loads the shipped source itself — the parts between `#region` markers — into
 * a sandbox with a fake surface. No bundler, no SDK import, no DOM:
 *
 *     node --test tests/
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

const SOURCE = readFileSync(new URL('../desktop/plugin.js', import.meta.url), 'utf8')

/** Slice a `#region name` … `#endregion name` block out of the plugin source. */
function region(name) {
  const open = `// #region ${name}`
  const close = `// #endregion ${name}`
  const start = SOURCE.indexOf(open)
  const end = SOURCE.indexOf(close, start + 1)

  assert.ok(start >= 0 && end > start, `region ${name} is missing from desktop/plugin.js`)

  return SOURCE.slice(start + open.length, end)
}

const CODE = [region('guard-consts'), region('colour-maths'), region('guard-fn')].join('\n')

/** Constants the guard borrows from the rest of the module. */
const STRENGTHS = { soft: 7, medium: 11, strong: 17 }
const TINT_ATTR = 'data-hcb-tint'

/** A chat surface as `paint()` leaves it before the guard runs: tinted, with
 *  the strength still unset. */
function surface() {
  const props = new Map([['--hcb-tint', 'color-mix(in srgb, #7c8cf8 11%, #17191f)']])
  const attrs = new Set([TINT_ATTR])

  return {
    props,
    attrs,
    style: {
      setProperty: (key, value) => props.set(key, String(value)),
      getPropertyValue: key => props.get(key) ?? '',
      removeProperty: key => props.delete(key)
    },
    hasAttribute: key => attrs.has(key),
    setAttribute: key => attrs.add(key),
    removeAttribute: key => attrs.delete(key)
  }
}

/** Load the shipped guard; `background(pct)` returns the resolved background
 *  the fake browser reports for a given fill strength. */
function loadGuard(background) {
  const seen = { value: null }
  const $contrast = { set: value => { seen.value = value } }
  const getComputedStyle = el => ({
    color: 'rgb(232, 235, 242)',
    backgroundColor: background(Number.parseFloat(el.props.get('--hcb-strength') ?? '0'))
  })
  const build = new Function(
    'getComputedStyle',
    'STRENGTHS',
    'TINT_ATTR',
    '$contrast',
    `${CODE}\nreturn { guardContrast, GUARD_FACTORS, MIN_CONTRAST }`
  )

  return { seen, ...build(getComputedStyle, STRENGTHS, TINT_ATTR, $contrast) }
}

const PREFS = { autoGuard: true, strength: 'medium' }
/** Fails 4.5:1 against the light ink above at any strength. */
const UNREADABLE = 'rgb(206, 208, 214)'
/** Passes comfortably. */
const READABLE = 'rgb(18, 20, 26)'

test('keeps the full wash when it already passes', () => {
  const { guardContrast, seen } = loadGuard(() => READABLE)
  const el = surface()

  guardContrast(el, PREFS)

  assert.equal(el.props.get('--hcb-strength'), '11.0%')
  assert.ok(el.props.has('--hcb-tint'))
  assert.equal(seen.value.pct, 11)
  assert.equal(seen.value.thinned, false)
  assert.ok(seen.value.ratio >= 4.5)
})

test('thins to half when the full wash fails', () => {
  const { guardContrast, seen } = loadGuard(pct => (pct >= 8 ? UNREADABLE : READABLE))
  const el = surface()

  guardContrast(el, PREFS)

  assert.equal(el.props.get('--hcb-strength'), '5.5%')
  assert.ok(el.props.has('--hcb-tint'))
  assert.equal(seen.value.thinned, true)
  assert.ok(seen.value.ratio >= 4.5)
})

// The regression: 1 / 0.5 / 0.25 can all miss, and the field must not be left
// with an unreadable wash on it.
test('removes the wash when every probe stays below the threshold', () => {
  const { guardContrast, seen } = loadGuard(() => UNREADABLE)
  const el = surface()

  guardContrast(el, PREFS)

  assert.equal(el.attrs.has(TINT_ATTR), false, 'tint attribute is cleared')
  assert.equal(el.props.has('--hcb-tint'), false, 'tint is cleared')
  assert.equal(el.props.has('--hcb-strength'), false, 'strength is cleared')
  assert.equal(seen.value.pct, 0)
  assert.equal(seen.value.thinned, true)
})

test('leaves the wash at the chosen strength when the guard is off', () => {
  const { guardContrast } = loadGuard(() => UNREADABLE)
  const el = surface()

  guardContrast(el, { ...PREFS, autoGuard: false })

  assert.ok(el.props.has('--hcb-tint'), 'tint survives')
  assert.equal(el.props.has('--hcb-strength'), false)
})

test('probes the full strength first, then half, then a quarter', () => {
  const { GUARD_FACTORS } = loadGuard(() => READABLE)

  assert.deepEqual([...GUARD_FACTORS], [1, 0.5, 0.25])
})
