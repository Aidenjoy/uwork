import { expect, it } from 'vitest'
import { formatBalance, formatPoints } from '../src/client/formatBalance.ts'

it.each([
  ['0.000000', '¥0.00'], ['12.34000000', '¥12.34'], ['1234.56999', '¥1,234.56'],
  ['0.00000001', '<¥0.01'], ['0.01', '¥0.01'], ['-0.000001', '-¥0.01'],
  ['-12.345', '-¥12.35'], ['-0.0000', '¥0.00'],
  // The Platform wire schema can carry exponent notation, which Big parses natively.
  ['0E-16', '¥0.00'], ['5.0000000000000000', '¥5.00'], ['5e0', '¥5.00'], ['1E-8', '<¥0.01'],
])('formats %s using Platform currency rules', (amount, expected) => {
  expect(formatBalance(amount, '¥')).toBe(expected)
})

it.each([
  ['0', '0'], ['0.0000', '0'], ['39', '39'], ['39.00', '39'],
  ['1234.50', '1,234.5'], ['1894.379', '1,894.37'], ['0.001', '<0.01'], ['-0.001', '-0.01'], ['-12.50', '-12.5'],
])('formats subscription points %s cleanly', (amount, expected) => {
  expect(formatPoints(amount)).toBe(expected)
})
