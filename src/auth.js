import { requestRailwayCatalog } from "./railwayCatalogApi.js";
import {
  railwayCatalogBranchKey,
  railwayCatalogTokenKey,
  railwayCatalogUserKey,
} from "./railwayCatalogConfig.js";

const railwayAuthListeners = new Set();
let railwayCatalogProfileCache = null;

const readStoredRailwayUser = () => {
  try {
    return JSON.parse(localStorage.getItem(railwayCatalogUserKey) || "null");
  } catch {
    return null;
  }
};

const clearRailwaySession = () => {
  railwayCatalogProfileCache = null;
  localStorage.removeItem(railwayCatalogTokenKey);
  localStorage.removeItem(railwayCatalogUserKey);
  localStorage.removeItem(railwayCatalogBranchKey);
};

const notifyRailwayAuthListeners = async (event, session) => {
  for (const listener of railwayAuthListeners) listener(event, session);
};

export async function getSession() {
  const token = localStorage.getItem(railwayCatalogTokenKey);
  if (!token) return null;
  try {
    const payload = await requestRailwayCatalog("/catalog/session");
    railwayCatalogProfileCache = payload.data;
    const user = { ...readStoredRailwayUser(), ...payload.data };
    localStorage.setItem(railwayCatalogUserKey, JSON.stringify(user));
    return { access_token: token, user };
  } catch (error) {
    if (error?.status === 401) clearRailwaySession();
    if (error?.status === 401) return null;
    throw error;
  }
}

export function onAuthChange(callback) {
  railwayAuthListeners.add(callback);
  queueMicrotask(async () => callback("INITIAL_SESSION", await getSession()));
  return {
    data: {
      subscription: {
        unsubscribe: () => railwayAuthListeners.delete(callback),
      },
    },
  };
}

export async function signIn(email, password) {
  const payload = await requestRailwayCatalog("/auth/login", {
    method: "POST",
    body: { username: email, password },
    authenticated: false,
  });
  railwayCatalogProfileCache = null;
  localStorage.setItem(railwayCatalogTokenKey, payload.token);
  localStorage.setItem(railwayCatalogUserKey, JSON.stringify(payload.user));
  const branchId = payload.user?.default_branch_id || payload.user?.branches?.[0]?.id;
  if (branchId) localStorage.setItem(railwayCatalogBranchKey, branchId);
  await notifyRailwayAuthListeners("SIGNED_IN", {
    access_token: payload.token,
    user: payload.user,
  });
}

export async function signOut() {
  clearRailwaySession();
  await notifyRailwayAuthListeners("SIGNED_OUT", null);
}

/**
 * Fetch the signed-in user's role from the profiles table.
 * Defaults to 'viewer' if no profile row is found yet, so a brand-new user
 * never accidentally gets elevated access before an admin assigns a role.
 */
export async function getMyProfile() {
  if (railwayCatalogProfileCache) return railwayCatalogProfileCache;
  const payload = await requestRailwayCatalog("/catalog/session");
  railwayCatalogProfileCache = payload.data;
  return railwayCatalogProfileCache;
}
