import { describe, expect, it } from 'vitest'
import { dayBucket } from '../src/index.ts'

describe('day buckets', () => {
  it('places dates in a Sunday-start week', () => {
    const bucket = (day: string) => dayBucket(day, '2026-11-11', '2026-11-08')
    expect(bucket('2026-11-10')).toBe('past')
    expect(bucket('2026-11-11')).toBe('today')
    expect(bucket('2026-11-12')).toBe('tomorrow')
    expect(bucket('2026-11-13')).toBe('this-week')
    expect(bucket('2026-11-14')).toBe('this-week')
    expect(bucket('2026-11-15')).toBe('next-week')
    expect(bucket('2026-11-21')).toBe('next-week')
    expect(bucket('2026-11-22')).toBe('later')
  })

  it('places dates in a Monday-start week', () => {
    const bucket = (day: string) => dayBucket(day, '2026-11-11', '2026-11-09')
    expect(bucket('2026-11-15')).toBe('this-week')
    expect(bucket('2026-11-16')).toBe('next-week')
    expect(bucket('2026-11-22')).toBe('next-week')
    expect(bucket('2026-11-23')).toBe('later')
  })

  it('calls the next day tomorrow even when it starts a new week', () => {
    expect(dayBucket('2026-11-15', '2026-11-14', '2026-11-08')).toBe('tomorrow')
    expect(dayBucket('2026-11-16', '2026-11-14', '2026-11-08')).toBe('next-week')
    expect(dayBucket('2026-11-16', '2026-11-15', '2026-11-09')).toBe('tomorrow')
    expect(dayBucket('2026-11-17', '2026-11-15', '2026-11-09')).toBe('next-week')
  })

  it('keeps the week across a year boundary', () => {
    expect(dayBucket('2027-01-02', '2026-12-30', '2026-12-27')).toBe('this-week')
    expect(dayBucket('2027-01-03', '2026-12-30', '2026-12-27')).toBe('next-week')
    expect(dayBucket('2027-01-03', '2026-12-30', '2026-12-28')).toBe('this-week')
    expect(dayBucket('2027-01-04', '2026-12-30', '2026-12-28')).toBe('next-week')
  })

  it('groups the far past and future', () => {
    expect(dayBucket('1900-01-01', '2026-11-11', '2026-11-08')).toBe('past')
    expect(dayBucket('2100-01-01', '2026-11-11', '2026-11-08')).toBe('later')
  })
})
