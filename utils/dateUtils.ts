/**
 * Date Utilities to handle Timezone consistency (specifically for Chile/Local time)
 * These utilities should prioritize the timezone provided by systemSettings.
 */

const DEFAULT_TIMEZONE = 'America/Santiago';

/**
 * Returns a string in YYYY-MM-DD format based on a logical 02:00 AM cutoff.
 * If current time is before 02:00 AM, it returns the previous day's date.
 */
export const getLogicalDateString = (dateObj: Date = new Date(), timezone: string = DEFAULT_TIMEZONE): string => {
    const formatter = new Intl.DateTimeFormat('en-CA', {
        timeZone: timezone,
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
        hour: '2-digit',
        minute: '2-digit',
        hour12: false
    });

    const parts = formatter.formatToParts(dateObj);
    const map: any = {};
    parts.forEach(p => map[p.type] = p.value);

    let hour = parseInt(map.hour);

    // LOGIC: If it's between 00:00 and 01:59 AM, we treat it as "yesterday"
    if (hour < 2) {
        const yesterday = new Date(dateObj.getTime());
        yesterday.setHours(yesterday.getHours() - 3); // Shift back enough to get yesterday in same TZ
        
        const yParts = formatter.formatToParts(yesterday);
        const yMap: any = {};
        yParts.forEach(p => yMap[p.type] = p.value);
        
        return `${yMap.year}-${yMap.month}-${yMap.day}`;
    }

    return `${map.year}-${map.month}-${map.day}`;
};

/**
 * Returns a string in YYYY-MM-DD format based on local time in the specified timezone.
 */
export const getLocalDateString = (dateObj: Date = new Date(), timezone: string = DEFAULT_TIMEZONE): string => {
    try {
        const formatter = new Intl.DateTimeFormat('en-CA', {
            timeZone: timezone,
            year: 'numeric',
            month: '2-digit',
            day: '2-digit'
        });
        const parts = formatter.formatToParts(dateObj);
        const map: any = {};
        parts.forEach(p => map[p.type] = p.value);
        return `${map.year}-${map.month}-${map.day}`;
    } catch (e) {
        // Fallback to simple local date if timezone is invalid
        const year = dateObj.getFullYear();
        const month = String(dateObj.getMonth() + 1).padStart(2, '0');
        const day = String(dateObj.getDate()).padStart(2, '0');
        return `${year}-${month}-${day}`;
    }
};

/**
 * Formats a date or string to a human-readable local date.
 */
export const formatLocalDisplayDate = (date: Date | string, timezone: string = DEFAULT_TIMEZONE): string => {
  const d = typeof date === 'string' ? new Date(date) : date;
  return d.toLocaleDateString('es-CL', {
    timeZone: timezone,
    year: 'numeric',
    month: 'long',
    day: 'numeric'
  });
};

/**
 * Returns the current time in local format.
 */
export const getLocalTimeString = (dateObj: Date = new Date(), timezone: string = DEFAULT_TIMEZONE): string => {
  return dateObj.toLocaleTimeString('es-CL', {
    timeZone: timezone,
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit'
  });
};

/**
 * Returns a Date object representing the logical date (yesterday if before 02:00 AM local time).
 */
export const getLogicalDate = (dateObj: Date = new Date(), timezone: string = DEFAULT_TIMEZONE): Date => {
  try {
    const formatter = new Intl.DateTimeFormat('en-CA', {
      timeZone: timezone,
      hour: '2-digit',
      hour12: false
    });
    const hour = parseInt(formatter.format(dateObj), 10);
    if (hour < 2) {
      return new Date(dateObj.getTime() - 24 * 60 * 60 * 1000);
    }
  } catch (e) {
    // Fallback if timezone formatting fails
    if (dateObj.getHours() < 2) {
      return new Date(dateObj.getTime() - 24 * 60 * 60 * 1000);
    }
  }
  return dateObj;
};
