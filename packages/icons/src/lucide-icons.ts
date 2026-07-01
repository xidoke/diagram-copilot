/**
 * Generic infra/UX icons baked in from `lucide-static` (ISC license).
 *
 * `lucide-static` has no `exports` map, so Node resolves the bare
 * specifier through its `main`/CJS entry; that entry statically assigns
 * `exports.Server = Server` etc., which Node's CJS/ESM interop (via
 * cjs-module-lexer) can turn into real named imports. Each icon string is
 * already `stroke="currentColor"`, so it themes for free.
 */
import {
  Bell,
  Box,
  Cloud,
  Cpu,
  Database,
  Globe,
  HardDrive,
  Layers,
  List,
  Lock,
  Mail,
  Monitor,
  Network,
  Router,
  Server,
  Shield,
  Smartphone,
  User,
  Users,
  Webhook,
} from "lucide-static";

import type { IconMeta } from "./types.js";

export const LUCIDE_LICENSE = "ISC";

function lucideIcon(id: string, title: string, svg: string): IconMeta {
  return { id, title, source: "lucide", license: LUCIDE_LICENSE, svg };
}

/** 20 generic icons covering the shapes a typical web/backend system needs. */
export const LUCIDE_ICONS: readonly IconMeta[] = [
  lucideIcon("server", "Server", Server),
  lucideIcon("database", "Database", Database),
  lucideIcon("globe", "Globe", Globe),
  lucideIcon("cloud", "Cloud", Cloud),
  lucideIcon("network", "Network", Network),
  lucideIcon("router", "Router", Router),
  lucideIcon("hard-drive", "Hard Drive", HardDrive),
  lucideIcon("layers", "Layers", Layers),
  lucideIcon("box", "Box", Box),
  lucideIcon("cpu", "CPU", Cpu),
  lucideIcon("shield", "Shield", Shield),
  lucideIcon("lock", "Lock", Lock),
  lucideIcon("user", "User", User),
  lucideIcon("users", "Users", Users),
  lucideIcon("mail", "Mail", Mail),
  lucideIcon("smartphone", "Smartphone", Smartphone),
  lucideIcon("monitor", "Monitor", Monitor),
  lucideIcon("bell", "Bell", Bell),
  lucideIcon("webhook", "Webhook", Webhook),
  lucideIcon("list", "List", List),
];

/** The lucide "box" artwork, reused verbatim as the soft-fallback icon. */
export const FALLBACK_SVG = Box;
export const FALLBACK_LICENSE = LUCIDE_LICENSE;
