import { z } from "zod";
import type { CreditQuota } from "../../../contracts/src/run-observation.js";

const amount = z.union([
  z.number(),
  z.string().regex(/^\d+(?:\.\d+)?$/).transform(Number),
]).pipe(z.number().finite().nonnegative());

const balances = z.object({
  CycleRemainCapacity: amount,
  CycleTotalCapacity: amount.optional(),
  CycleUsedCapacity: amount.optional(),
  CapacityUnit: z.literal("credits").optional(),
});
const response = z.object({
  code: z.union([z.literal(0), z.literal("0")]).optional(),
  data: z.object({
    TotalCredits: amount.optional(),
    Packages: z.array(balances.extend({
      PackageCode: z.string().trim().min(1).max(128),
    })).min(1).max(200),
    CreditGroups: z.array(balances.extend({
      Kind: z.string().trim().min(1).max(128),
      Name: z.string().trim().min(1).max(128),
      TotalCount: z.number().int().nonnegative(),
    })).max(200).optional(),
  }),
});

export function parseCodeBuddyCreditQuota(raw: unknown): CreditQuota | undefined {
  const parsed = response.safeParse(raw);
  if (!parsed.success) return;
  const { Packages, CreditGroups, TotalCredits } = parsed.data.data;
  const packages = Packages.map(pkg => ({
    code: pkg.PackageCode,
    remaining: pkg.CycleRemainCapacity,
    total: pkg.CycleTotalCapacity,
    used: pkg.CycleUsedCapacity,
  }));
  if (new Set(packages.map(pkg => pkg.code)).size !== packages.length) return;
  const sum = (key: "total" | "used" | "remaining") => {
    let total = 0;
    for (const pkg of packages) {
      if (pkg[key] === undefined) return;
      total += pkg[key]!;
    }
    return Number.isFinite(total) ? total : undefined;
  };
  const remaining = TotalCredits ?? sum("remaining");
  if (remaining === undefined) return;
  const groups = CreditGroups?.filter(group => group.TotalCount > 0).map(group => ({
    code: group.Kind,
    name: group.Name,
    remaining: group.CycleRemainCapacity,
    total: group.CycleTotalCapacity,
    used: group.CycleUsedCapacity,
  }));
  return { remaining, total: sum("total"), used: sum("used"),
    packages: groups?.length && new Set(groups.map(group => group.code)).size === groups.length ? groups : packages };
}
