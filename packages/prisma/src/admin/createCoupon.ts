// New exported helper created because `Coupon` has no in-application creation
// path (admin/ops tooling inserts these by raw SQL in production). The Autonoma
// entity audit marks Coupon as `independently_created: true` with
// `needs_extraction: true`; this thin wrapper is the extraction — a named,
// importable function the Environment Factory can call instead of inlining a
// raw `prisma.coupon.create` inside the factory body. See
// autonoma/entity-audit.md for context.
import prisma from "..";

export type CreateCouponInput = {
  code: string;
  userPropertiesToUpdate: unknown;
  dateRedeemed?: Date | null;
};

export const createCoupon = async ({
  code,
  userPropertiesToUpdate,
  dateRedeemed = null,
}: CreateCouponInput) => {
  return prisma.coupon.create({
    data: {
      code,
      userPropertiesToUpdate: userPropertiesToUpdate as object,
      dateRedeemed,
    },
  });
};
