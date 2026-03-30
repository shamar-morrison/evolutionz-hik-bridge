export function toNumberIfNumeric(value) {
  if (typeof value !== 'string') {
    return value;
  }

  const trimmed = value.trim();

  if (trimmed === '' || Number.isNaN(Number(trimmed))) {
    return value;
  }

  return Number(trimmed);
}

export function toBoolean(value, fallback = false) {
  if (typeof value === 'boolean') {
    return value;
  }

  if (typeof value === 'string') {
    const normalized = value.trim().toLowerCase();

    if (normalized === 'true' || normalized === '1') {
      return true;
    }

    if (normalized === 'false' || normalized === '0') {
      return false;
    }
  }

  return fallback;
}

export function normalizeList(value) {
  if (!value) {
    return [];
  }

  return Array.isArray(value) ? value : [value];
}

export function pad(value) {
  return String(value).padStart(2, '0');
}

export function formatDatePart(date) {
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

export function canonicalizeEmployeeNo(value) {
  if (typeof value !== 'string') {
    return '';
  }

  const trimmed = value.trim();

  if (!trimmed) {
    return '';
  }

  if (!/^\d+$/.test(trimmed)) {
    return trimmed;
  }

  const normalized = trimmed.replace(/^0+/, '');
  return normalized || '0';
}

export function getNumericField(value, fallback) {
  const numericValue = Number(value);
  return Number.isFinite(numericValue) ? numericValue : fallback;
}

export function normalizeSearchMetadata(searchResult, fallbackCount) {
  return {
    responseStatusStrg: String(searchResult?.responseStatusStrg ?? 'OK').toUpperCase(),
    numOfMatches: getNumericField(searchResult?.numOfMatches, fallbackCount),
    totalMatches: getNumericField(searchResult?.totalMatches, fallbackCount),
  };
}

export function shouldContinuePagedSearch({
  responseStatus,
  searchResultPosition,
  matchesOnPage,
  totalMatches,
}) {
  if (matchesOnPage <= 0) {
    return false;
  }

  const normalizedStatus = String(responseStatus ?? 'OK').toUpperCase();

  if (normalizedStatus === 'MORE') {
    return true;
  }

  return searchResultPosition + matchesOnPage < totalMatches;
}
