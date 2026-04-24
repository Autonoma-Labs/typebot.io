import { verifyUnsubscribeToken } from "@typebot.io/user/verifyUnsubscribeToken";
import { z } from "zod";
import { suppressEmail } from "./suppressEmail";

export const unsubscribeEmailInputSchema = z.object({
  query: z
    .object({
      email: z.string().optional(),
      token: z.string().optional(),
    })
    .optional(),
});

export const handleUnsubscribeEmail = async ({
  input,
}: {
  input: z.infer<typeof unsubscribeEmailInputSchema>;
}) => {
  const email = input.query?.email ?? "";
  const token = input.query?.token ?? "";
  if (!email || !token) return { message: "Ignored request" };
  if (!verifyUnsubscribeToken(email, token))
    return { message: "Invalid unsubscribe token" };

  await suppressEmail(email);

  return { message: "Unsubscribed" };
};
