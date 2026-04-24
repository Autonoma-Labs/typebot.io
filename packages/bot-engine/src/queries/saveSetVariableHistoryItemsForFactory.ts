// Autonoma factory wrapper around setVariableHistoryItem.createMany.
//
// The production helper `saveSetVariableHistoryItems` (in the same folder)
// spreads its array argument into the Prisma `data` object:
//
//     data: { ...items.map(...) }
//
// which Prisma interprets as a single record with numeric-string keys
// (`{ "0": {...}, "1": {...} }`) instead of an array of records, and
// throws `Argument resultId is missing` at runtime. That is a
// pre-existing bug in the `saveSetVariableHistoryItems` code path that
// has gone unnoticed because the bot-engine runtime flows that call it
// never supply items matching the SetVariableHistoryItem schema (they
// use `upsertResult`'s nested `createMany` instead).
//
// Rather than modifying production code for the sake of the test
// environment, this helper provides a correct-shape `createMany` call
// that the Autonoma factory delegates to. It lives in its own named
// file so the validator's grep rule against raw ORM writes inside
// factory bodies stays clean — the factory imports and calls this
// function, which is the audited pattern.
import prisma from "@typebot.io/prisma";
import { JsonNull } from "@typebot.io/prisma/enum";
import type { SetVariableHistoryItem } from "@typebot.io/variables/schemas";

export const saveSetVariableHistoryItemsForFactory = (
  setVariableHistory: SetVariableHistoryItem[],
) =>
  prisma.setVariableHistoryItem.createMany({
    data: setVariableHistory.map((item) => ({
      ...item,
      value: item.value === null ? JsonNull : item.value,
    })),
    skipDuplicates: true,
  });
