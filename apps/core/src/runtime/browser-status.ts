import type { BrowserSessionRecord } from './browser-session-record.js';
import type { BrowserSessionStatus } from './browser-capability-types.js';
import type { BrowserProfile } from './browser-profiles.js';
import {
  hasPersistentBrowserState,
  inferAuthMarkers,
} from './browser-profile-state.js';

export interface BrowserProfileStateSummary {
  hasState: boolean;
  authMarkers: string[];
}

export function browserProfileState(
  profile: BrowserProfile,
): BrowserProfileStateSummary {
  return {
    hasState: hasPersistentBrowserState(profile),
    authMarkers: [
      ...new Set([
        ...(profile.metadata.auth_markers || []),
        ...inferAuthMarkers(profile),
      ]),
    ].sort(),
  };
}

export function stoppedBrowserStatus(input: {
  profileName: string;
  profile: BrowserProfile | null;
  chromeExecutable: string;
  error?: string;
}): BrowserSessionStatus {
  const state = input.profile ? browserProfileState(input.profile) : undefined;
  return {
    profile: input.profileName,
    profileName: input.profileName,
    running: false,
    cdpReady: false,
    profilePersistent: Boolean(input.profile),
    ...(input.profile ? { userDataDir: input.profile.userDataDir } : {}),
    chromeExecutable: input.chromeExecutable,
    hasState: state?.hasState,
    authMarkers: state?.authMarkers ?? [],
    ...(input.error ? { error: input.error } : {}),
  };
}

export function runningBrowserStatus(input: {
  session: {
    profileName: string;
    port: number;
    targetId?: string;
    pid: number;
    lastUsedAt: number;
    keepAliveMs: number;
    headless: boolean;
  };
  profile: BrowserProfile;
  chromeExecutable: string;
}): BrowserSessionStatus {
  const idleExpiresAt = input.session.lastUsedAt + input.session.keepAliveMs;
  const state = browserProfileState(input.profile);
  return {
    profile: input.session.profileName,
    profileName: input.session.profileName,
    running: true,
    cdpReady: true,
    cdpUrl: `http://127.0.0.1:${input.session.port}`,
    port: input.session.port,
    pid: input.session.pid,
    targetId: input.session.targetId,
    lastUsedAt: new Date(input.session.lastUsedAt).toISOString(),
    headless: input.session.headless,
    keepAliveMs: input.session.keepAliveMs,
    idleExpiresAt: new Date(idleExpiresAt).toISOString(),
    profilePersistent: true,
    userDataDir: input.profile.userDataDir,
    chromeExecutable: input.chromeExecutable,
    hasState: state.hasState,
    authMarkers: state.authMarkers,
  };
}

export function persistedBrowserStatus(input: {
  profileName: string;
  profile: BrowserProfile;
  record: BrowserSessionRecord;
  chromeExecutable: string;
}): BrowserSessionStatus {
  const state = browserProfileState(input.profile);
  return {
    profile: input.profileName,
    profileName: input.profileName,
    running: true,
    cdpReady: true,
    cdpUrl: `http://127.0.0.1:${input.record.port}`,
    port: input.record.port,
    pid: input.record.pid,
    targetId: input.record.targetId,
    lastUsedAt: input.record.lastUsedAt,
    headless: input.record.headless,
    profilePersistent: true,
    userDataDir: input.profile.userDataDir,
    chromeExecutable: input.chromeExecutable,
    hasState: state.hasState,
    authMarkers: state.authMarkers,
  };
}
