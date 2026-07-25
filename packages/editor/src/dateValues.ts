const SHORT_MONTHS = [
  "Jan",
  "Feb",
  "Mar",
  "Apr",
  "May",
  "Jun",
  "Jul",
  "Aug",
  "Sep",
  "Oct",
  "Nov",
  "Dec",
] as const;

const LONG_MONTHS = [
  "January",
  "February",
  "March",
  "April",
  "May",
  "June",
  "July",
  "August",
  "September",
  "October",
  "November",
  "December",
] as const;

interface DateParts {
  year: number;
  month: number;
  day: number;
}

function validDate(parts: DateParts): boolean {
  const date = new Date(Date.UTC(parts.year, parts.month - 1, parts.day));
  return (
    date.getUTCFullYear() === parts.year &&
    date.getUTCMonth() === parts.month - 1 &&
    date.getUTCDate() === parts.day
  );
}

function parts(year: string, month: string, day: string): DateParts | null {
  const parsed = { year: Number(year), month: Number(month), day: Number(day) };
  return validDate(parsed) ? parsed : null;
}

function namedMonth(value: string): number | null {
  const normalized = value.toLowerCase();
  const index = LONG_MONTHS.findIndex(
    (month) => month.toLowerCase() === normalized || month.slice(0, 3).toLowerCase() === normalized,
  );
  return index < 0 ? null : index + 1;
}

function parseDate(value: string): DateParts | null {
  const source = value.trim();
  const iso = /^(\d{4})-(\d{2})-(\d{2})(?:[Tt ].*)?$/.exec(source);
  if (iso) return parts(iso[1], iso[2], iso[3]);

  const monthFirst = /^([A-Za-z]+)\s+(\d{1,2}),?\s+(\d{4})$/.exec(source);
  if (monthFirst) {
    const month = namedMonth(monthFirst[1]);
    return month === null ? null : parts(monthFirst[3], String(month), monthFirst[2]);
  }

  const dayFirst = /^(\d{1,2})\s+([A-Za-z]+)\s+(\d{4})$/.exec(source);
  if (dayFirst) {
    const month = namedMonth(dayFirst[2]);
    return month === null ? null : parts(dayFirst[3], String(month), dayFirst[1]);
  }

  const numeric = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(source);
  if (numeric) return parts(numeric[3], numeric[1], numeric[2]);

  const yearFirst = /^(\d{4})\/(\d{1,2})\/(\d{1,2})$/.exec(source);
  return yearFirst ? parts(yearFirst[1], yearFirst[2], yearFirst[3]) : null;
}

function isoDate(value: DateParts): string {
  return `${String(value.year).padStart(4, "0")}-${String(value.month).padStart(2, "0")}-${String(value.day).padStart(2, "0")}`;
}

function matchingCase(value: string, template: string): string {
  if (template === template.toUpperCase()) return value.toUpperCase();
  if (template === template.toLowerCase()) return value.toLowerCase();
  return value;
}

/** Value accepted by a native date input for common frontmatter spellings. */
export function dateControlValue(value: string): string {
  const parsed = parseDate(value);
  return parsed ? isoDate(parsed) : "";
}

/** Converts a native date-input value back to the spelling already used by
 * the document. Astro's blog template uses `Jul 08 2022`. */
export function dateValueFromControl(value: string, template: string): string {
  const parsed = parseDate(value);
  if (!parsed || value === "") return value;
  const source = template.trim();

  const monthFirst = /^([A-Za-z]+)\s+(\d{1,2})(,?)\s+(\d{4})$/.exec(source);
  if (monthFirst) {
    const monthName =
      monthFirst[1].length <= 3 ? SHORT_MONTHS[parsed.month - 1] : LONG_MONTHS[parsed.month - 1];
    const month = matchingCase(monthName, monthFirst[1]);
    const day =
      monthFirst[2].length === 2 ? String(parsed.day).padStart(2, "0") : String(parsed.day);
    return `${month} ${day}${monthFirst[3]} ${parsed.year}`;
  }

  const dayFirst = /^(\d{1,2})\s+([A-Za-z]+)\s+(\d{4})$/.exec(source);
  if (dayFirst) {
    const day = dayFirst[1].length === 2 ? String(parsed.day).padStart(2, "0") : String(parsed.day);
    const monthName =
      dayFirst[2].length <= 3 ? SHORT_MONTHS[parsed.month - 1] : LONG_MONTHS[parsed.month - 1];
    return `${day} ${matchingCase(monthName, dayFirst[2])} ${parsed.year}`;
  }

  const numeric = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(source);
  if (numeric) {
    const month =
      numeric[1].length === 2 ? String(parsed.month).padStart(2, "0") : String(parsed.month);
    const day = numeric[2].length === 2 ? String(parsed.day).padStart(2, "0") : String(parsed.day);
    return `${month}/${day}/${parsed.year}`;
  }

  const yearFirst = /^(\d{4})\/(\d{1,2})\/(\d{1,2})$/.exec(source);
  if (yearFirst) {
    const month =
      yearFirst[2].length === 2 ? String(parsed.month).padStart(2, "0") : String(parsed.month);
    const day =
      yearFirst[3].length === 2 ? String(parsed.day).padStart(2, "0") : String(parsed.day);
    return `${parsed.year}/${month}/${day}`;
  }

  const iso = /^\d{4}-\d{2}-\d{2}([Tt ].*)$/.exec(source);
  return iso ? `${isoDate(parsed)}${iso[1]}` : isoDate(parsed);
}
