// Extracted Effect runtime wrapper around `PrismaSpacesRepo.create` so the
// Autonoma Environment Factory can reuse the same Prisma write path the
// production SpacesUsecases.create goes through. See autonoma/entity-audit.md —
// Space's creation_function is `PrismaSpacesRepo.create`, which lives inside an
// Effect Layer; calling it directly requires providing PrismaService, which is
// what this helper does. The factory intentionally skips the feature-flag and
// workspace-access checks in SpacesUsecases because those are user-action
// policy checks, not part of the data write, and the factory is a trusted data
// fixture caller (not an unauthenticated user request).
import { PrismaLayer } from "@typebot.io/prisma/layer";
import { Effect, Layer } from "effect";
import type { SpaceCreateInput } from "../../application/SpacesRepo";
import { SpacesRepo } from "../../application/SpacesRepo";
import { PrismaSpacesRepo } from "../../infrastructure/PrismaSpacesRepo";

const FactoryLayer = Layer.provide(PrismaSpacesRepo, PrismaLayer);

export const createSpaceForFactory = async (input: SpaceCreateInput) => {
  const program = Effect.gen(function* () {
    const repo = yield* SpacesRepo;
    return yield* repo.create(input);
  }).pipe(Effect.provide(FactoryLayer));

  return Effect.runPromise(program);
};
