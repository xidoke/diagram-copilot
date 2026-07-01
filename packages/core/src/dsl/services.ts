import {
  EmptyFileSystem,
  createDefaultCoreModule,
  createDefaultSharedCoreModule,
  inject,
  type LangiumCoreServices,
  type LangiumSharedCoreServices,
} from "langium";
import { ArchDslGeneratedModule, ArchDslGeneratedSharedModule } from "./generated/module.js";

/** Langium service containers for the arch-dsl language. */
export interface ArchDslServices {
  shared: LangiumSharedCoreServices;
  ArchDsl: LangiumCoreServices;
}

/**
 * Create the arch-dsl Langium services (core only — no LSP).
 *
 * Uses {@link EmptyFileSystem}: parsing works purely on in-memory strings,
 * which keeps `parseDsl` synchronous via `LangiumParser.parse()`.
 */
export function createArchDslServices(): ArchDslServices {
  const shared = inject(
    createDefaultSharedCoreModule(EmptyFileSystem),
    ArchDslGeneratedSharedModule,
  );
  const ArchDsl = inject(createDefaultCoreModule({ shared }), ArchDslGeneratedModule);
  shared.ServiceRegistry.register(ArchDsl);
  return { shared, ArchDsl };
}
