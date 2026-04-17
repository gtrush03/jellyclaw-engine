/**
 * Barrel for the autobuild-v4 surface. Import from here, not from the
 * individual files, so agent 3's subcomponent rewrites don't ripple into
 * callers.
 */

export { AutobuildV4 } from './AutobuildV4';

// --- Subcomponents (stubs today, replaced by agent 3) --------------------
export { StatusHeader } from './StatusHeader';
export type { StatusHeaderProps } from './StatusHeader';
export { TierTrack } from './TierTrack';
export type { TierTrackProps } from './TierTrack';
export { NowCard } from './NowCard';
export type { NowCardProps } from './NowCard';
export { UpNextList } from './UpNextList';
export type { UpNextListProps } from './UpNextList';
export { DoneFeed } from './DoneFeed';
export type { DoneFeedProps } from './DoneFeed';
export { EmptyState } from './EmptyState';
export type { EmptyStateProps } from './EmptyState';
