/**
 * @diagram-copilot/layout
 *
 * Placeholder entrypoint for the layout package. Real ELK-based
 * auto-layout logic will land here.
 */
import { ARCH_EXT } from "@diagram-copilot/core";

export const LAYOUT_PACKAGE_NAME = "@diagram-copilot/layout";

/** Proves the cross-package import of @diagram-copilot/core contracts works. */
export function placeholder(): string {
  return `${LAYOUT_PACKAGE_NAME}+${ARCH_EXT}`;
}
