import { AutobuildV4 } from "@/components/autobuild-v4";

/**
 * Top-level route component for `#/autobuild-v4`. Thin passthrough so the
 * chrome (Header, SSE listeners at App root) stays intact while the whole
 * viewport body is taken over by the v4 surface.
 */
export default function AutobuildV4Page() {
  return <AutobuildV4 />;
}
