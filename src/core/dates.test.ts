import { describe, expect, it } from "vitest";
import {
  addDays,
  daysInMonth,
  formatDay,
  formatLongDay,
  formatRelative,
  lastNDays,
  monthStart,
  syncStartDay,
  utcDay,
} from "./dates";

describe("dates", () => {
  it("uses UTC days regardless of local time zone", () => {
    expect(utcDay(new Date("2026-10-17T23:30:00-07:00"))).toBe("2026-10-18");
  });

  it("adds days across month boundaries", () => {
    expect(addDays("2026-10-01", -1)).toBe("2026-09-30");
    expect(addDays("2026-12-31", 1)).toBe("2027-01-01");
  });

  it("finds the month start and length", () => {
    expect(monthStart(new Date("2026-10-17T12:00:00Z"))).toBe("2026-10-01");
    expect(daysInMonth(new Date("2026-02-10T00:00:00Z"))).toBe(28);
    expect(daysInMonth(new Date("2028-02-10T00:00:00Z"))).toBe(29);
    expect(daysInMonth(new Date("2026-10-17T00:00:00Z"))).toBe(31);
  });

  it("lists the last N days ending today", () => {
    const days = lastNDays(new Date("2026-10-17T08:00:00Z"), 30);
    expect(days).toHaveLength(30);
    expect(days[0]).toBe("2026-09-18");
    expect(days[29]).toBe("2026-10-17");
  });

  it("syncs from whichever is earlier: month start or 30 days ago", () => {
    expect(syncStartDay(new Date("2026-10-17T08:00:00Z"))).toBe("2026-09-18");
    expect(syncStartDay(new Date("2026-10-31T08:00:00Z"))).toBe("2026-10-01");
  });

  it("formats a day for people", () => {
    expect(formatDay("2026-10-12")).toBe("Oct 12");
    expect(formatLongDay("2026-11-06")).toBe("November 6, 2026");
  });

  it("formats how long ago something happened", () => {
    const now = new Date("2026-10-17T12:00:00Z");
    expect(formatRelative("2026-10-17T11:59:40Z", now)).toBe("just now");
    expect(formatRelative("2026-10-17T11:55:00Z", now)).toBe("5 min ago");
    expect(formatRelative("2026-10-17T09:00:00Z", now)).toBe("3 h ago");
    expect(formatRelative("2026-10-16T10:00:00Z", now)).toBe("1 day ago");
    expect(formatRelative("2026-10-14T12:00:00Z", now)).toBe("3 days ago");
  });
});
