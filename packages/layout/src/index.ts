/**
 * @diagram-copilot/layout
 *
 * Placeholder entrypoint for the layout package. Real ELK-based
 * auto-layout logic will land here.
 */
import { CORE_PACKAGE_NAME } from "@diagram-copilot/core";

export const LAYOUT_PACKAGE_NAME = "@diagram-copilot/layout";

export function placeholder(): string {
  return `${LAYOUT_PACKAGE_NAME}+${CORE_PACKAGE_NAME}`;
}
