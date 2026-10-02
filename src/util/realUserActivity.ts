const STORAGE_KEY = 'egoist_real_user_activity';
const realActivityMap = new Map<string, number>();

// Load persisted activity from localStorage
try {
  const stored = localStorage.getItem(STORAGE_KEY);
  if (stored) {
    const parsed = JSON.parse(stored);
    if (parsed && typeof parsed === 'object') {
      Object.entries(parsed).forEach(([id, ts]) => {
        if (typeof ts === 'number' && ts > 0) {
          realActivityMap.set(id, ts);
        }
      });
    }
  }
} catch {
  // Ignore storage errors
}

let persistTimeout: ReturnType<typeof setTimeout> | undefined;
function schedulePersist() {
  if (persistTimeout) return;
  persistTimeout = setTimeout(() => {
    persistTimeout = undefined;
    try {
      const obj: Record<string, number> = {};
      realActivityMap.forEach((ts, id) => {
        obj[id] = ts;
      });
      localStorage.setItem(STORAGE_KEY, JSON.stringify(obj));
    } catch {
      // Ignore storage errors
    }
  }, 1000);
}

export function recordUserActivity(userId: string, timestampSeconds?: number) {
  if (!userId) return;
  const ts = timestampSeconds || Math.floor(Date.now() / 1000);
  const existing = realActivityMap.get(userId) || 0;
  if (ts > existing) {
    realActivityMap.set(userId, ts);
    schedulePersist();
  }
}

export function getRealUserActivity(userId: string): number | undefined {
  return realActivityMap.get(userId);
}

export function getIsUserRecentlyActive(userId: string, thresholdSeconds = 180): boolean {
  const lastActive = realActivityMap.get(userId);
  if (!lastActive) return false;
  const now = Math.floor(Date.now() / 1000);
  return (now - lastActive) <= thresholdSeconds;
}
